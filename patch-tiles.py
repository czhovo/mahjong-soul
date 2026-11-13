"""Generate/install/restore coded default tile textures using the user's game files."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
import UnityPy
from UnityPy.enums import TextureFormat
from PIL import ImageDraw
from coded_tiles import TILES, ROWS, marker_image, draw_suit_stripe, draw_label, tile_image

ROOT = Path(__file__).resolve().parent
DEFAULT_BUNDLE = 'uwv8ssu@8b6258224gelc_be-fhjf0s1ggibqlln@wc-b-1vvxn_b904b2e371cf3fe23a9b.majset'
TEXTURES = {f'myassets/deco/mjpface/mjpface_default/3d/texture/{n}.png' for n in ('hand','hand_0','mjp','mjp_0')}
UnityPy.config.FALLBACK_UNITY_VERSION = '2022.3.62f2'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def generate(original):
    env = UnityPy.load(original)
    expected = {}
    for path, obj in env.container.items():
        if path not in TEXTURES:
            continue
        texture = obj.read()
        atlas = texture.image.convert('RGBA')
        if texture.m_Name.startswith('hand'):
            if atlas.size != (800, 516):
                raise ValueError(f'Unsupported hand atlas size: {atlas.size}')
            layout = [[s+str(i) for i in range(10)] for s in ('T','W','B')] + [['Z'+str(i) for i in range(1,8)]]
            for row, tiles in enumerate(layout):
                for col, tile in enumerate(tiles):
                    x, y = col*80, row*129
                    ImageDraw.Draw(atlas).rectangle((x+4,y+16,x+75,y+123),fill='white')
                    atlas.paste(marker_image(TILES.index(tile),60).convert('RGBA'),(x+10,y+30))
                    draw_suit_stripe(atlas,tile,x+10,y+30,60)
                    draw_label(atlas,tile,(x+4,y+96,x+76,y+124),18)
        else:
            if atlas.size != (512,512):
                raise ValueError(f'Unsupported public atlas size: {atlas.size}')
            for row, tiles in enumerate(ROWS):
                for col, tile in enumerate(tiles):
                    atlas.paste(tile_image(TILES.index(tile)),(col*52,row*73))
        expected[path] = atlas.tobytes()
        texture.set_image(atlas,target_format=TextureFormat.RGBA32)
        texture.save()
    if set(expected) != TEXTURES:
        raise ValueError('Default tile textures not found. Game resource layout may have changed; no files installed.')
    data = env.file.save(packer='lz4')
    verify = UnityPy.load(data)
    for path, pixels in expected.items():
        if verify.container[path].read().image.convert('RGBA').tobytes() != pixels:
            raise ValueError(f'Texture round-trip check failed: {path}')
    return data

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir',type=Path,required=True,help='Directory containing Jantama_MahjongSoul.exe')
    parser.add_argument('--bundle',default=DEFAULT_BUNDLE,help='Bundle filename, if a later game version renamed it')
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--install',action='store_true',help='Back up and replace game textures (close the game first)')
    action.add_argument('--restore',action='store_true',help='Restore the exact backup made by this checkout')
    args = parser.parse_args()
    if Path(args.bundle).name != args.bundle:
        parser.error('--bundle must be a filename, not a path')
    target = args.game_dir.resolve()/'Jantama_MahjongSoul_Data/StreamingAssets/StandaloneWindows'/args.bundle
    if not target.is_file():
        parser.error(f'Game bundle not found: {target}')
    folder = ROOT/'private/tile-backups'/hashlib.sha256(str(target).encode('utf-8')).hexdigest()[:16]
    folder.mkdir(parents=True,exist_ok=True)
    backup, modified, record = folder/'original.majset', folder/'coded.majset', folder/'manifest.json'
    current = target.read_bytes()
    previous = json.loads(record.read_text(encoding='utf-8')) if record.exists() else None
    if args.restore:
        if not previous or not backup.exists():
            parser.error('No backup from this checkout; nothing restored')
        if digest(current) not in (previous['original_sha256'],previous['replacement_sha256']):
            parser.error('Game file changed since installation; refusing to overwrite an update')
        data = backup.read_bytes()
        if digest(data) != previous['original_sha256']:
            parser.error('Backup hash mismatch')
        target.write_bytes(data)
        print('Original textures restored:',target)
        return
    if backup.exists():
        if not previous or digest(current) not in (previous['original_sha256'],previous['replacement_sha256']):
            parser.error('Game file changed since backup; keep this backup and use a fresh checkout for the new game version')
        original = backup.read_bytes()
        if digest(original) != previous['original_sha256']:
            parser.error('Backup hash mismatch')
    else:
        original = current
    data = generate(original)
    if not backup.exists():
        backup.write_bytes(original)
    modified.write_bytes(data)
    metadata = {'game_file':str(target),'original_sha256':digest(original),'replacement_sha256':digest(data),'texture_pixel_roundtrip':True}
    record.write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
    active = dict(metadata, source=str(target), backup=str(backup), replacement=str(modified))
    (ROOT/'private/active-tiles.json').write_text(json.dumps(active,ensure_ascii=False,indent=2),encoding='utf-8')
    if args.install:
        shutil.copyfile(modified,target)
        if digest(target.read_bytes()) != metadata['replacement_sha256']:
            raise RuntimeError('Installed file hash mismatch')
        print('Coded default textures installed:',target)
    else:
        print('Generated and verified, game file unchanged:',modified)
    print('Backup:',backup)

if __name__ == '__main__':
    main()
