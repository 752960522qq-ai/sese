"""Install the selected PCM cues from the game's sound ZIP without re-encoding."""
import argparse
import csv
import io
import json
import re
import wave
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'app/src/main/assets/audio'
WAV_PATH = re.compile(r'0[1-4]_[a-z]+/[a-z0-9_]+\.wav')


def install(archive):
    entries, files = [], {}
    with ZipFile(archive) as source:
        manifest = source.read('音效清单.csv').decode('utf-8-sig')
        for row in csv.DictReader(io.StringIO(manifest)):
            path = row['文件']
            if not WAV_PATH.fullmatch(path) or path in files:
                raise ValueError(f'Invalid or duplicate sound path {path!r}')
            if source.getinfo(path).file_size > 4 * 1024 * 1024:
                raise ValueError(f'Sound is larger than expected {path!r}')
            wave_bytes = source.read(path)
            with wave.open(io.BytesIO(wave_bytes)) as audio:
                if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (2, 2, 44100, 'NONE'):
                    raise ValueError(f'Expected stereo PCM 44.1 kHz {path!r}')
                duration = audio.getnframes() / audio.getframerate()
                if not 0 < duration <= 20:
                    raise ValueError(f'Invalid cue duration {path!r}')
            entries.append({
                'id': path[:-4], 'path': path, 'label': row['片段'], 'group': row['类别'],
                'duration': duration, 'candidate': row['高潮段候选'] == '是'
            })
            files[path] = wave_bytes
    if len(files) != 44:
        raise ValueError('Expected the 44 reviewed game sounds')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for path, content in files.items():
        dest = OUTPUT / path
        dest.parent.mkdir(exist_ok=True)
        dest.write_bytes(content)
    (OUTPUT / 'cues.json').write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding='utf8')
    print(f'Sound bank installed, {len(entries)} clips')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    install(parser.parse_args().archive)
