#!/usr/bin/env python3
"""Local terminal only. Never accept the key as an argument or echo it."""
import getpass
import os
from pathlib import Path
import re
import sys
import stat
import tempfile

def write_key(root, key, replace=False):
    private = Path(root) / '.private'
    target = private / 'mimo-api-key'
    if not re.fullmatch(r'sk-[\x21-\x7e]{13,4093}', key):
        raise ValueError('需要普通 API 的 sk- 密钥，不能使用 Token Plan 密钥。')
    if private.is_symlink():
        raise ValueError('私有目录不能是符号链接。')
    private.mkdir(mode=0o700, exist_ok=True)
    if replace:
        current = target.lstat()
        if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or current.st_uid != os.getuid() or current.st_mode & 0o077:
            raise ValueError('原凭证文件不安全，未替换。')
        fd, temporary = tempfile.mkstemp(prefix='.mimo-key-', dir=private)
        try:
            with os.fdopen(fd, 'w') as f:
                f.write(key)
                f.flush()
                os.fsync(f.fileno())
            latest = target.lstat()
            if (latest.st_ino, latest.st_mtime_ns, latest.st_size) != (current.st_ino, current.st_mtime_ns, current.st_size):
                raise ValueError('凭证文件已被其他进程修改，未替换。')
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    else:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(key)
            f.flush()
            os.fsync(f.fileno())


def main():
    try:
        if not sys.stdin.isatty():
            raise ValueError('请在本机交互终端运行；不接受管道或命令参数中的密钥。')
        if sys.argv[1:] not in ([], ['--replace']):
            raise ValueError('仅接受 --replace 选项，不接受密钥参数。')
        key = getpass.getpass('MiMo 普通 API Key（sk- 开头，输入隐藏）：').strip()
        write_key(Path(__file__).resolve().parent.parent, key, replace=sys.argv[1:] == ['--replace'])
        print('已保存到项目私有目录，权限 600。不会发出 API 请求。重启 npm run start:configured 后生效。')
    except FileExistsError:
        print('私有密钥文件已存在，未覆盖。若要更新，请重新运行 python3 scripts/configure-mimo.py --replace。', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError) as error:
        print(str(error) if isinstance(error, ValueError) else '私有文件写入失败，请检查权限。', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
