import hashlib, json, os, re, shutil, stat, sys

# A stand-in for a Windows host, used only where the behavior tests run
# without PowerShell: it is given the scripts the workbench sends there and
# does what they do with the same requests, so that the cases of a Windows
# remote can be read on a POSIX machine.
#
# The operation is given as an argument:
#   script  the input is one script, which names the operation and carries
#           the request written into it
#   file    the input is the length of a script, the script, the bytes of a
#           file and a confirmation byte: the script is read from the input
#           by the loader on the command line, as on a Windows host
# otherwise the operation is the argument and the request is the input
mode = sys.argv[1]
# The input is read from the descriptor itself: what follows a script may be
# the bytes of a file, which a stream opened as text would alter. Where a
# descriptor has a text mode, it is taken off.
BINARY = getattr(os, "O_BINARY", 0)
if os.name == "nt":
    import msvcrt
    msvcrt.setmode(0, os.O_BINARY)
chunks = []
while True:
    chunk = os.read(0, 262144)
    if not chunk:
        break
    chunks.append(chunk)
body = b"".join(chunks)
errors = {}

def quoted(text):
    """What a PowerShell single-quoted literal holds."""
    return text.replace("''", "'")

if mode == "script":
    text = body.decode("utf-8")
    op = re.search(r"AWB_UPLOAD_OP ([a-z]+)", text).group(1)
    req = json.loads(quoted(re.search(r"^\$req = '(.*)' \| ConvertFrom-Json$", text, re.M).group(1)))
    errors = req.get("errors") or {}
elif mode == "file":
    line_end = body.index(b"\n")
    length = int(body[:line_end])
    text = body[line_end + 1:line_end + 1 + length].decode("utf-8")
    op = "write"
    req = {
        "root": quoted(re.search(r"^\$parent=\(Resolve-Path -LiteralPath '(.*)' -ErrorAction Stop\)\.Path$", text, re.M).group(1)),
        # Each step of the walk into the folder names one part: the match
        # stops at the first closing quote, or a later step would be swallowed.
        "parts": [quoted(part) for part in re.findall(r"\$parent=Join-Path \$parent '(.*?)'; \$item=", text)],
        # The walk into the folder is written on the line the root is resolved
        # on, and the temporary file's name follows it on the same line.
        "temporary": quoted(re.search(r"\$tmp=Join-Path \$parent '(.*)'$", text, re.M).group(1)),
        "name": quoted(re.search(r"\[IO\.File\]::Move\(\$tmp,\(Join-Path \$parent '(.*)'\)\)", text).group(1)),
        "size": int(re.search(r"\$remaining=\[long\](\d+)", text).group(1)),
        "bytes": body[line_end + 1 + length:],
    }
else:
    op = mode
    req = json.loads(body)
    errors = req.get("errors") or {}

def translated(source):
    """A message of the request, in the language the workbench was asked for."""
    return errors.get(source, source)

root = os.path.realpath(req["root"])
parent_rel = str(req.get("parent") or "").strip("/")
parent = root if not parent_rel else os.path.realpath(os.path.join(root, parent_rel))
if parent != root and not parent.startswith(root + os.sep):
    raise SystemExit("cannot replace the project root")

def remove(path):
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.remove(path)

def version(path):
    """What Get-AwbEntryVersion makes of an entry: its times and attributes,
    its length and its content are part of it, and it is read again after the
    content to tell an entry that is changing while it is read."""
    if not os.path.lexists(path):
        return "absent"
    if os.path.islink(path):
        raise SystemExit("path contains a link")
    before = os.lstat(path)
    if stat.S_ISDIR(before.st_mode):
        parts = [str(before.st_ino), str(before.st_mtime_ns)]
        for name in sorted(os.listdir(path)):
            child = version(os.path.join(path, name))
            if child == "absent":
                raise SystemExit("the target directory is changing")
            parts.append(f"{len(name)}:{name}:{child}")
        digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()
        kind = "d"
    else:
        with open(path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        parts = [str(before.st_ino), str(before.st_mtime_ns), str(before.st_size)]
        kind = "f"
    after = os.lstat(path)
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise SystemExit("the target is changing")
    metadata = hashlib.sha256((":".join(parts) + ":" + digest).encode("utf-8")).hexdigest()
    return kind + ":" + metadata

if op == "exist":
    rel = str(req.get("relative") or "").strip("/")
    path = root if not rel else os.path.join(root, rel)
    print("yes" if os.path.lexists(path) else "no")
elif op == "version":
    rel = str(req.get("relative") or "").strip("/")
    print(version(os.path.join(parent, rel)))
elif op == "mkdir":
    # A folder of the staging tree, which does not exist yet. The folders
    # above it are made too, as New-Item makes them.
    os.makedirs(os.path.join(parent, str(req["name"])), exist_ok=True)
elif op == "remove":
    for item in req.get("items") or []:
        name = str(item.get("stage") or "")
        if not name.startswith(".awb-upload-tree-"):
            continue
        remove(os.path.join(parent, name))
    print("removed")
elif op == "write":
    # The script writes a temporary file with the bytes that follow it on the
    # input and moves it to its name once the sender has confirmed; a
    # transfer that is short or unconfirmed leaves nothing behind.
    here = parent
    for part in req["parts"]:
        here = os.path.join(here, part)
    temporary = os.path.join(here, req["temporary"])
    payload = req["bytes"]
    expected = req["size"]
    if len(payload) < expected:
        raise SystemExit("incomplete")
    if len(payload) == expected or payload[expected] != 1:
        raise SystemExit("unconfirmed")
    try:
        handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | BINARY, 0o600)
        try:
            view = memoryview(payload[:expected])
            while view:
                view = view[os.write(handle, view):]
            os.fsync(handle)
        finally:
            os.close(handle)
        os.rename(temporary, os.path.join(here, req["name"]))
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
elif op == "publish":
    # As the Electron build publishes: the old entry is moved to a backup and
    # the stage to its name; the backup is removed once that is done. What was
    # moved away is put back if the stage could not be published, and a backup
    # that could not be removed is left where it is and said so.
    for item in req.get("items") or []:
        dest = os.path.join(parent, item["name"])
        stage = os.path.join(parent, item["stage"])
        backup = os.path.join(parent, item["stage"].replace("tree-", "backup-", 1))
        moved = False
        published = False
        try:
            if not os.path.lexists(stage):
                raise SystemExit(translated("临时上传不存在"))
            version(stage)
            if version(dest) != item["version"]:
                raise SystemExit(translated("目标已更改，原对象已保留"))
            if item["version"] != "absent":
                os.rename(dest, backup)
                moved = True
                if version(backup) != item["version"]:
                    raise SystemExit(translated("目标已更改，原对象已保留"))
            os.rename(stage, dest)
            published = True
            if moved:
                try:
                    remove(backup)
                    moved = False
                except OSError:
                    print(translated("AWB_WARNING:替换已完成，旧对象清理失败，保留于 ") + backup)
        except SystemExit:
            if moved and not published:
                if os.path.lexists(dest):
                    raise SystemExit(translated("替换失败，原对象保留于 ") + backup)
                os.rename(backup, dest)
                moved = False
            raise
        finally:
            if not published and os.path.lexists(stage):
                remove(stage)
else:
    raise SystemExit("unknown operation " + op)
