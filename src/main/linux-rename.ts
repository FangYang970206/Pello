/** Linux atomic, no-replace rename, anchored to opened directory descriptors. */
export const LINUX_RENAME_SCRIPT = `import ctypes, errno, os, stat, sys
root, relative, name, want_dir, target_parent = sys.argv[1:]
parts = relative.split('/')
target_parts = target_parent.split('/') if target_parent else []
if not parts or any(p in ('', '.', '..') for p in parts + target_parts) or name in ('', '.', '..') or '/' in name:
    raise ValueError('非法路径')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
fd = os.open(root, flags)
dest_fd = os.dup(fd)
try:
    for part in parts[:-1]:
        next_fd = os.open(part, flags | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    for part in target_parts:
        next_fd = os.open(part, flags | os.O_NOFOLLOW, dir_fd=dest_fd)
        os.close(dest_fd)
        dest_fd = next_fd
    info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode) or (want_dir == '1' and not stat.S_ISDIR(info.st_mode)) or (want_dir == '0' and not stat.S_ISREG(info.st_mode)):
        raise ValueError('文件类型已更改或路径包含符号链接')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise OSError(errno.ENOSYS, '系统不支持安全重命名')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(fd, os.fsencode(parts[-1]), dest_fd, os.fsencode(name), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
finally:
    os.close(fd)
    os.close(dest_fd)
`
/** Create through pinned directory descriptors, refusing linked ancestors. */
export const LINUX_CREATE_SCRIPT = `import os, sys
root, relative, name, directory = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
try:
    for part in relative.split('/') if relative else []:
        nxt = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = nxt
    if directory == '1':
        os.mkdir(name, dir_fd=parent)
    else:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o666, dir_fd=parent)
        os.close(fd)
finally:
    os.close(parent)
`
