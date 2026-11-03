import test from 'node:test';
import {execFileSync} from 'node:child_process';

const setup=`
import importlib.util, tempfile, pathlib, os
spec = importlib.util.spec_from_file_location('configure_mimo', 'scripts/configure-mimo.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
old = 'sk-SYNTHETIC_OLD_KEY_ONLY'
new = 'sk-SYNTHETIC_NEW_KEY_ONLY'
`;
const check=code=>execFileSync('python3',['-B','-c',setup+code],{stdio:'pipe'});

test('MiMo local configuration creates mode 600 and refuses implicit overwrite',()=>check(`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    module.write_key(root, old)
    target = root / '.private/mimo-api-key'
    assert target.stat().st_mode & 0o777 == 0o600
    try: module.write_key(root, new)
    except FileExistsError: pass
    else: raise AssertionError('implicit overwrite')
    assert target.read_text() == old
`));
test('MiMo explicit replacement is atomic, private and leaves no temporary credential',()=>check(`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    module.write_key(root, old)
    module.write_key(root, new, replace=True)
    target = root / '.private/mimo-api-key'
    assert target.read_text() == new
    assert target.stat().st_mode & 0o777 == 0o600
    assert list(target.parent.glob('.mimo-key-*')) == []
`));
test('MiMo replacement rejects symlinks and does not modify their destination',()=>check(`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    private = root / '.private'
    private.mkdir()
    outside = root / 'outside'
    outside.write_text(old)
    (private / 'mimo-api-key').symlink_to(outside)
    try: module.write_key(root, new, replace=True)
    except ValueError: pass
    else: raise AssertionError('followed link')
    assert outside.read_text() == old
`));
test('MiMo replacement rejects insecure files and invalid key types without loss',()=>check(`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    module.write_key(root, old)
    target = root / '.private/mimo-api-key'
    target.chmod(0o644)
    try: module.write_key(root, new, replace=True)
    except ValueError: pass
    else: raise AssertionError('insecure target')
    target.chmod(0o600)
    try: module.write_key(root, 'tp-SYNTHETIC_TOKEN_PLAN', replace=True)
    except ValueError: pass
    else: raise AssertionError('wrong key type')
    assert target.read_text() == old
`));
