import base64, hashlib, json, os, re, shutil, sys, uuid

# A Linux host is given the operation as an argument and the request on the
# input. A Windows host is given one script on the input, which names the
# operation and carries the request written into it.
op = sys.argv[1]
body = sys.stdin.read()
if op == "script":
    op = re.search(r"AWB_UPLOAD_OP ([a-z]+)", body).group(1)
    quoted = re.search(r"^\$req = '(.*)' \| ConvertFrom-Json$", body, re.M).group(1)
    req = json.loads(quoted.replace("''", "'"))
else:
    req = json.loads(body)
root = os.path.realpath(req["root"])
parent_rel = str(req.get("parent") or "").strip("/")
parent = root if not parent_rel else os.path.realpath(os.path.join(root, parent_rel))
if parent != root and not parent.startswith(root + os.sep):
    raise SystemExit("cannot replace the project root")

def version(path):
    if not os.path.lexists(path):
        return "absent"
    if os.path.islink(path):
        raise SystemExit("path contains a link")
    digest = hashlib.sha256()
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            child = os.path.join(path, name)
            if os.path.islink(child):
                raise SystemExit("path contains a link")
            digest.update(name.encode())
            digest.update(b"\0")
            digest.update(version(child).encode())
        return "d:" + digest.hexdigest()
    with open(path, "rb") as handle:
        digest.update(handle.read())
    return "f:" + digest.hexdigest()

def write_node(dest, node):
    if node.get("dir"):
        os.mkdir(dest)
        for child in node.get("children") or []:
            write_node(os.path.join(dest, child["name"]), child)
    else:
        with open(dest, "wb") as handle:
            handle.write(base64.b64decode(node.get("data") or ""))

if op == "exist":
    rel = str(req.get("relative") or "").strip("/")
    path = root if not rel else os.path.realpath(os.path.join(root, rel))
    print("yes" if os.path.lexists(path) else "no")
elif op == "remove":
    for item in req.get("items") or []:
        name = str(item.get("stage") or "")
        if not name.startswith(".awb-upload-tree-"):
            continue
        path = os.path.join(parent, name)
        if os.path.isdir(path):
            shutil.rmtree(path)
        elif os.path.lexists(path):
            os.remove(path)
    print("removed")
elif op == "stage":
    results = []
    for item in req.get("items") or []:
        name = item["name"]
        if name in ("", ".", "..") or "/" in name or "\\" in name:
            raise SystemExit("invalid name")
        dest = os.path.join(parent, name)
        expected = version(dest)
        stage_name = ".awb-upload-tree-" + str(uuid.uuid4())
        write_node(os.path.join(parent, stage_name), item)
        results.append({"name": name, "stage": stage_name, "version": expected})
    print(json.dumps(results))
elif op == "publish":
    for item in req.get("items") or []:
        dest = os.path.join(parent, item["name"])
        stage = os.path.join(parent, item["stage"])
        if not os.path.lexists(stage):
            raise SystemExit("staged upload is missing")
        if version(dest) != item["version"]:
            shutil.rmtree(stage) if os.path.isdir(stage) else os.remove(stage)
            raise SystemExit("target changed and the original was kept")
        backup = os.path.join(parent, item["stage"].replace("tree-", "backup-", 1))
        if item["version"] != "absent":
            os.rename(dest, backup)
        os.rename(stage, dest)
        if item["version"] != "absent":
            try:
                shutil.rmtree(backup) if os.path.isdir(backup) else os.remove(backup)
            except OSError:
                print("AWB_WARNING:" + backup)
