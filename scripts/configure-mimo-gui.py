#!/usr/bin/env python3
"""macOS-only credential dialog. Clipboard and key never enter logs or arguments."""
import importlib.util
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DIALOG = '''
activate
set candidate to ""
set hint to "请先复制 MiMo 普通 API 密钥，再点击「从剪贴板粘贴」。输入框以圆点显示，点击「保存」才会写入本机配置。"
repeat
    try
        set response to display dialog hint with title "刘禹博的 AIGC · MiMo 密钥配置" default answer candidate buttons {"取消", "从剪贴板粘贴", "保存"} default button "保存" cancel button "取消" with hidden answer
    on error number -128
        return ""
    end try
    if button returned of response is "从剪贴板粘贴" then
        try
            set candidate to the clipboard as text
            if (length of candidate) > 4096 then
                set candidate to ""
                set hint to "剪贴板内容过长。请只复制 API 密钥，然后重新粘贴。"
            else
                set hint to "已从剪贴板粘贴。输入框中的圆点代表密钥，请点击「保存」。"
            end if
        on error
            set candidate to ""
            set hint to "剪贴板没有可用文本。请复制 API 密钥，然后重新粘贴。"
        end try
    else
        return text returned of response
    end if
end repeat
'''


def dialog(script):
    # osascript's result is captured directly in memory; never inherit stdout.
    result = subprocess.run(['/usr/bin/osascript', '-e', script],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError('DIALOG_UNAVAILABLE')
    return result.stdout.strip()


def notice(message):
    # Only constant application messages are allowed here, never a key or exception.
    dialog('activate\ndisplay dialog "' + message +
           '" with title "刘禹博的 AIGC · MiMo 密钥配置" buttons {"好的"} default button "好的"')


def main():
    spec = importlib.util.spec_from_file_location('mimo_local_config', ROOT / 'scripts/configure-mimo.py')
    config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config)
    try:
        while True:
            key = dialog(DIALOG)
            if not key:
                return 0
            try:
                config.write_key(ROOT, key, replace=True)
            except ValueError:
                notice('未保存。请确认复制的是完整的 sk- 开头普通 API 密钥，并检查私有文件权限。原配置保留。')
                continue
            except OSError:
                notice('本机文件写入失败，原配置保留。请检查私有目录权限。')
                return 1
            finally:
                key = ''
            notice('密钥已保存到本机私有配置，权限为 600。请回到对话告诉我「已保存」，继续真实出图测试。')
            return 0
    except Exception:
        # Never expose captured subprocess output or credential contents on errors.
        return 1


if __name__ == '__main__':
    sys.exit(main())
