#!/usr/bin/env python3
"""Pack an AtelierMesh plugin folder into a .amplugin file, with Python 3 only (no Node, no npm, nothing to install).

    python3 amplugin_pack.py <plugin folder> [--out file.amplugin] [--no-hashes]

The folder holds manifest.json, main.js (plain JavaScript, one file, no imports) and optionally assets/. The result is the same package the Node tool
(`node amplugin.mjs pack`) makes: a ZIP with manifest.json, main.js, the assets and manifest.sha256 (one "<sha256>  <path>" line per file, sorted by path).
It is NOT signed: signing needs the Node tool (`node amplugin.mjs sign`). TypeScript is not supported here: write main.js.
Part of the AtelierMesh plugin kit. The npm package called "amplugin" is a different, unrelated project.
"""
import argparse
import decimal
import hashlib
import json
import os
import re
import sys
import zipfile

PLUGIN_ID = re.compile(r'^[a-z0-9]+(\.[a-z0-9][a-z0-9_-]*)+$')
SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')

LICENSE_RE = re.compile(r'^[A-Za-z0-9.+\- ]+$')
EMAIL_RE = re.compile(r'^[^\s@<>"\'()\[\],;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$')
CONTROL_RE = re.compile(r'[\x00-\x1f\x7f]')


def https_problem(v, maxlen):
    """Why v is not an acceptable https address (None when it is): https only, no user name or password, a real host name."""
    from urllib.parse import urlsplit
    if not isinstance(v, str) or not v:
        return 'must be text'
    if len(v) > maxlen:
        return 'is longer than %d characters' % maxlen
    if CONTROL_RE.search(v) or re.search(r'\s', v):
        return 'contains spaces or control characters'
    try:
        u = urlsplit(v)
        host = u.hostname or ''
        u.port
    except ValueError:
        return 'is not a valid address'
    if u.scheme != 'https':
        return 'must start with https://'
    if u.username or u.password:
        return 'must not contain a user name or password'
    if '.' not in host:
        return 'needs a real host name'
    return None


IMAGE_PATH = re.compile(r'^[A-Za-z0-9_./-]{1,100}$')
IMAGE_MAX_BYTES, IMAGE_MAX_W, IMAGE_MAX_H, IMAGE_MIN_W = 300 * 1024, 1600, 1200, 200


def image_path_ok(p):
    return isinstance(p, str) and bool(IMAGE_PATH.match(p)) and not p.startswith('/') and not any(s in ('', '.', '..') for s in p.split('/'))


def sniff_image(b):
    """(mime, width, height) of a PNG, JPEG or WebP found by its first bytes, or None."""
    import struct
    if len(b) >= 24 and b[:8] == b'\x89PNG\r\n\x1a\n':
        w, h = struct.unpack('>II', b[16:24])
        return 'image/png', w, h
    if len(b) >= 4 and b[0] == 0xFF and b[1] == 0xD8:
        o = 2
        while o + 9 < len(b):
            if b[o] != 0xFF:
                o += 1
                continue
            m = b[o + 1]
            if m == 0xFF:
                o += 1
                continue
            if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                o += 2
                continue
            n = (b[o + 2] << 8) | b[o + 3]
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                return 'image/jpeg', (b[o + 7] << 8) | b[o + 8], (b[o + 5] << 8) | b[o + 6]
            if n < 2:
                return None
            o += 2 + n
        return None
    if len(b) >= 30 and b[:4] == b'RIFF' and b[8:12] == b'WEBP':
        k = b[12:16]
        if k == b'VP8 ':
            return 'image/webp', (b[26] | (b[27] << 8)) & 0x3FFF, (b[28] | (b[29] << 8)) & 0x3FFF
        if k == b'VP8L':
            v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
            return 'image/webp', (v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1
        if k == b'VP8X':
            return 'image/webp', (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    return None


def image_problem(manifest, files):
    """Why the example picture named in the manifest cannot be used (None when there is none or it is fine). files: path -> bytes."""
    im = manifest.get('image')
    if not isinstance(im, dict) or not image_path_ok(im.get('file')):
        return None
    data = files.get(im['file'])
    if data is None:
        return '"image.file" names "%s", which is not in the package (put the picture in assets/ and write "assets/<file>")' % im['file']
    info = sniff_image(data)
    if info is None:
        return 'the example picture "%s" must be a PNG, JPEG or WebP picture' % im['file']
    if len(data) > IMAGE_MAX_BYTES:
        return 'the example picture "%s" is %d bytes; the most allowed is %d (300 KB)' % (im['file'], len(data), IMAGE_MAX_BYTES)
    _mime, w, h = info
    if w < IMAGE_MIN_W or w > IMAGE_MAX_W or h < 1 or h > IMAGE_MAX_H:
        return 'the example picture "%s" is %d x %d px; it must be at least %d px wide and at most %d x %d px' % (im['file'], w, h, IMAGE_MIN_W, IMAGE_MAX_W, IMAGE_MAX_H)
    return None


def metadata_problems(m):
    """Readable problems with license, description, contact and package_url (the same rules as the Node tool and the host)."""
    out = []
    lic = m.get('license')
    if not isinstance(lic, str) or not lic.strip():
        out.append('manifest.json has no "license". Add one, for example "license": "MIT" (an SPDX identifier such as MIT, Apache-2.0 or GPL-3.0-only, or "Proprietary").')
    elif len(lic) > 64 or not LICENSE_RE.match(lic):
        out.append('"license" is not usable: use an SPDX identifier such as MIT or Apache-2.0, or "Proprietary", at most 64 characters of letters, digits and . + - and spaces.')
    d = m.get('description')
    if not isinstance(d, str) or not d.strip():
        out.append('manifest.json has no "description". Add one or two sentences (10 to 300 characters, plain text) that say what the plugin does.')
    elif len(d.strip()) < 10 or len(d) > 300 or CONTROL_RE.search(d):
        out.append('"description" is not usable: plain text of 10 to 300 characters with no line breaks.')
    c = m.get('contact')
    if c is not None:
        if not isinstance(c, dict):
            out.append('"contact" must be an object like {"url": "https://...", "email": "you@example.org", "name": "You"}.')
        else:
            for k in c:
                if k not in ('url', 'email', 'name'):
                    out.append('"contact.%s" is not a known field (use url, email, name).' % k)
            if 'url' in c:
                why = https_problem(c['url'], 200)
                if why:
                    out.append('"contact.url" %s.' % why)
            if 'email' in c and not (isinstance(c['email'], str) and len(c['email']) <= 120 and EMAIL_RE.match(c['email'])):
                out.append('"contact.email" must be an address like you@example.org.')
            if 'name' in c and not (isinstance(c['name'], str) and c['name'].strip() and len(c['name']) <= 80 and not CONTROL_RE.search(c['name'])):
                out.append('"contact.name" must be plain text of 1 to 80 characters.')
    if 'package_url' in m:
        why = https_problem(m['package_url'], 300)
        if why:
            out.append('"package_url" %s.' % why)
    if 'image' in m:
        im = m['image']
        if not isinstance(im, dict):
            out.append('"image" must be an object like {"file": "assets/example.png", "alt": "what the picture shows"}.')
        else:
            for k in im:
                if k not in ('file', 'alt'):
                    out.append('"image.%s" is not a known field (use file, alt).' % k)
            if not image_path_ok(im.get('file')):
                out.append('"image.file" must be a relative path inside the package, for example "assets/example.png".')
            a = im.get('alt')
            if not (isinstance(a, str) and 5 <= len(a.strip()) and len(a) <= 160 and not CONTROL_RE.search(a)):
                out.append('"image.alt" must be plain text of 5 to 160 characters that describes the picture.')
    return out

OP_ID = re.compile(r'^[a-z][a-z0-9_]*$')
MAX_PACKAGE = 20 * 1024 * 1024

# What a plugin must not do (the same rules `amplugin check` applies): the host runs it with no network, no clock and no random numbers.
RULES = [
    (re.compile(r'\bMath\.random\b'), 'Math.random makes every run different: use a seeded generator'),
    (re.compile(r'\bcrypto\.(getRandomValues|randomUUID)\b'), 'random numbers make every run different: use a seeded generator'),
    (re.compile(r'\bDate\.now\b|\bnew Date\b|\bDate\(\)|\bperformance\.now\b'), 'the clock makes every run different'),
    (re.compile(r'\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bimportScripts\b|\bsendBeacon\b|\bEventSource\b'), 'a plugin has no network'),
    (re.compile(r'\beval\s*\(|\bnew Function\b|(^|[^.\w])Function\s*\('), 'no eval and no new Function'),
    (re.compile(r'^\s*import\s*[\w{*\'"]|\bimport\s*\(|\brequire\s*\(', re.M), 'main.js must be ONE file with no imports'),
    (re.compile(r'\b(localStorage|sessionStorage|indexedDB|document\.cookie|postMessage)\b'), 'a plugin keeps no state outside its own run'),
]


def scan(source):
    """Rule violations as (line, message, text). Comments are not code, so they are blanked first."""
    text = re.sub(r'/\*[\s\S]*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), source)
    text = re.sub(r'(^|[^:\\\'"`])//[^\n]*', lambda m: m.group(1), text, flags=re.M)
    found = []
    for number, line in enumerate(text.split('\n'), 1):
        for rule, why in RULES:
            if rule.search(line):
                found.append((number, why, line.strip()[:100]))
    return found


def js_float(x):
    """A float the way JavaScript prints it (JSON.stringify): 1.0 -> 1, 1e-05 -> 0.00001, 1e-07 -> 1e-7."""
    if x != x or x in (float('inf'), float('-inf')):
        return 'null'
    if x == 0:
        return '0'
    sign = '-' if x < 0 else ''
    d = decimal.Decimal(repr(abs(x))).normalize()
    digits = ''.join(str(i) for i in d.as_tuple().digits)
    k = len(digits)
    n = d.as_tuple().exponent + k
    if k <= n <= 21:
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * (-n) + digits
    e = n - 1
    exp = ('e+' if e >= 0 else 'e-') + str(abs(e))
    return sign + (digits if k == 1 else digits[0] + '.' + digits[1:]) + exp


def dumps_js(value, depth=0):
    """json.dumps(indent=2) that matches JavaScript's JSON.stringify(value, null, 2) byte for byte (so both tools write the same manifest.json)."""
    pad, inner = '  ' * depth, '  ' * (depth + 1)
    if isinstance(value, dict):
        if not value:
            return '{}'
        return '{\n' + ',\n'.join(inner + json.dumps(k, ensure_ascii=False) + ': ' + dumps_js(v, depth + 1) for k, v in value.items()) + '\n' + pad + '}'
    if isinstance(value, list):
        if not value:
            return '[]'
        return '[\n' + ',\n'.join(inner + dumps_js(v, depth + 1) for v in value) + '\n' + pad + ']'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return 'null'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return js_float(value)
    return json.dumps(value, ensure_ascii=False)


def listing(files):
    """manifest.sha256: '<sha256>  <path>' per file (not the side files), sorted by path as JavaScript sorts strings (UTF-16 code units)."""
    names = sorted((n for n in files if n not in ('manifest.sha256', 'manifest.sig')), key=lambda n: n.encode('utf-16-be'))
    return ''.join('%s  %s\n' % (hashlib.sha256(files[n]).hexdigest(), n) for n in names).encode('utf-8')


LANG_FILE_RE = re.compile(r'^[a-z]{2,3}(?:-(?:[A-Za-z]{2}|[0-9]{3}))?\.json$')
LOCALE_KEY_RE = re.compile(r'^[A-Za-z0-9_-]{1,60}$')


def own_key(manifest, key):
    """The namespace rule: ops.<own op>.*, step.op.<own op>, mesh.<own op or last part of the plugin id>.*"""
    parts = key.split('.')
    if len(parts) < 3:
        return False
    ops = [o.get('id') for o in manifest.get('operations', []) if isinstance(o, dict)]
    if parts[0] == 'step':
        return parts[1] == 'op' and len(parts) == 3 and parts[2] in ops
    if parts[0] == 'ops':
        return parts[1] in ops
    if parts[0] == 'mesh':
        return parts[1] in ops or parts[1] == str(manifest.get('id', '')).split('.')[-1]
    return False


def suggest_key(manifest, key):
    """Where a text outside the namespace probably belongs (None when there is no good guess). Same rules as suggestKey in packages/loader/src/locales.ts."""
    parts = key.split('.')
    last = parts[-1]
    ops = [o.get('id') for o in manifest.get('operations', []) if isinstance(o, dict)]
    prefixes = list(dict.fromkeys(ops + [str(manifest.get('id', '')).split('.')[-1]]))
    op = ops[0] if len(ops) == 1 else '<operation id>'
    if parts[0] in ('work', 'stage', 'stages', 'progress') or 'stage' in parts or 'stages' in parts or 'progress' in parts:
        return 'ops.%s.stage.%s' % (op, last)
    if parts[0] == 'mesh' and len(parts) >= 3:
        return 'mesh.%s.%s' % (prefixes[-1], '.'.join(parts[2:]))
    if parts[0] in prefixes and len(parts) >= 2:
        return 'mesh.%s.%s' % (parts[0], '.'.join(parts[1:]))
    if parts[0] in ('error', 'errors', 'warning', 'warnings', 'problem', 'problems') and len(parts) >= 2:
        return 'mesh.%s.%s' % (prefixes[-1], '.'.join(parts[1:]))
    return None


def locale_problems(folder, manifest):
    """What a host would refuse or leave out in <folder>/locales: at most 8 language files of 64 KB, objects of depth 6 holding at most 2000 plain texts of 1000 characters, keys inside the plugin's namespace."""
    base = os.path.join(folder, 'locales')
    out = []
    if not os.path.isdir(base):
        return out
    names = sorted(n for n in os.listdir(base) if os.path.isfile(os.path.join(base, n)))
    langs = [n for n in names if LANG_FILE_RE.match(n)]
    for n in names:
        if n not in langs:
            out.append('%s is not a language file (a name like en.json or nl-BE.json): a host ignores it' % n)
    if len(langs) > 8:
        out.append('at most 8 language files (%d found)' % len(langs))
    leaves = [0]

    def walk(node, prefix, depth, n):
        for k, v in node.items():
            path = prefix + [k]
            dotted = '.'.join(path)
            if isinstance(v, dict):
                if depth + 1 > 6:
                    out.append('%s: "%s" is deeper than 6 levels' % (n, dotted))
                else:
                    walk(v, path, depth + 1, n)
            elif isinstance(v, str):
                leaves[0] += 1
                if len(v) > 1000:
                    out.append('%s: "%s" is longer than 1000 characters' % (n, dotted))
                elif not all(LOCALE_KEY_RE.match(s) for s in path) or not own_key(manifest, dotted):
                    out.append('%s: "%s" is outside the plugin\'s own namespace (ops.<operation id>.*, step.op.<operation id>, mesh.<operation id or last part of the plugin id>.*)%s: a host ignores it' % (n, dotted, (' - move it to ' + suggest_key(manifest, dotted)) if suggest_key(manifest, dotted) else ''))
            else:
                out.append('%s: "%s" must be text or an object' % (n, dotted))

    for n in langs:
        p = os.path.join(base, n)
        if os.path.getsize(p) > 64 * 1024:
            out.append('%s is larger than 64 KB' % n)
            continue
        try:
            with open(p, encoding='utf-8') as f:
                d = json.load(f)
        except ValueError:
            out.append('%s is not valid JSON' % n)
            continue
        if not isinstance(d, dict):
            out.append('%s must hold one JSON object' % n)
            continue
        walk(d, [], 1, n)
    if leaves[0] > 2000:
        out.append('more than 2000 texts (%d)' % leaves[0])
    return out


def collect_locales(folder):
    out = {}
    base = os.path.join(folder, 'locales')
    if os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            path = os.path.join(base, name)
            if os.path.isfile(path):
                with open(path, 'rb') as f:
                    out['locales/' + name] = f.read()
    return out


def collect_assets(folder):
    out = {}
    base = os.path.join(folder, 'assets')
    if os.path.isdir(base):
        for root, _dirs, names in os.walk(base):
            for name in names:
                path = os.path.join(root, name)
                rel = os.path.relpath(path, folder).replace(os.sep, '/')
                with open(path, 'rb') as f:
                    out[rel] = f.read()
    return out


def write_zip(path, entries):
    """A ZIP with stored (uncompressed) entries and a fixed timestamp, so the same input gives the same bytes."""
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            info.flag_bits |= 0x800
            z.writestr(info, data)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Pack an AtelierMesh plugin folder into a .amplugin file (Python 3 only).')
    ap.add_argument('folder')
    ap.add_argument('--out')
    ap.add_argument('--no-hashes', action='store_true', help='leave out manifest.sha256')
    ap.add_argument('--key', help='not supported here: signing needs the Node tool')
    args = ap.parse_args(argv)
    if args.key:
        print('signing is not possible with Python: pack here, then run `node amplugin.mjs sign <folder> --key <key>` where Node exists.', file=sys.stderr)
        return 2
    mf = os.path.join(args.folder, 'manifest.json')
    if not os.path.isfile(mf):
        print('no manifest.json in %s' % args.folder, file=sys.stderr)
        return 2
    if not os.path.isfile(os.path.join(args.folder, 'main.js')):
        print('no main.js: this tool packs plain JavaScript only (write main.js by hand, one file, no imports)', file=sys.stderr)
        return 2
    try:
        with open(mf, encoding='utf-8') as f:
            manifest = json.loads(f.read(), parse_float=float, parse_int=int)
    except ValueError as e:
        print('manifest.json is not valid JSON: %s' % e, file=sys.stderr)
        return 2
    problems = []
    if not isinstance(manifest, dict):
        problems.append('manifest.json must hold one JSON object')
    else:
        if manifest.get('manifest_version') != 1:
            problems.append('manifest_version must be 1')
        if not isinstance(manifest.get('id'), str) or not PLUGIN_ID.match(manifest['id']):
            problems.append('id must look like com.example.my_plugin (lowercase letters, digits, dots)')
        if not isinstance(manifest.get('name'), str) or not manifest['name']:
            problems.append('name is missing')
        if not isinstance(manifest.get('version'), str) or not SEMVER.match(manifest['version']):
            problems.append('version must look like 1.0.0')
        problems.extend(metadata_problems(manifest))
        ops = manifest.get('operations')
        if not isinstance(ops, list) or not ops:
            problems.append('operations must be a non-empty list')
        else:
            for i, op in enumerate(ops):
                if not isinstance(op, dict) or not isinstance(op.get('id'), str) or not OP_ID.match(op['id']):
                    problems.append('operations[%d].id must be lowercase letters, digits and underscores' % i)
    with open(os.path.join(args.folder, 'main.js'), encoding='utf-8') as f:
        source = f.read()
    for line, why, text in scan(source):
        problems.append('main.js line %d: %s    %s' % (line, why, text))
    if problems:
        print('not packed:\n  ' + '\n  '.join(problems), file=sys.stderr)
        return 1
    files = {'manifest.json': dumps_js(manifest).encode('utf-8'), 'main.js': source.encode('utf-8')}
    files.update(collect_assets(args.folder))
    lp = locale_problems(args.folder, manifest)
    if lp:
        print('not packed (locales/):\n  ' + '\n  '.join(lp), file=sys.stderr)
        return 1
    files.update(collect_locales(args.folder))
    why = image_problem(manifest, files)
    if why:
        print('manifest.json: ' + why, file=sys.stderr)
        return 1
    entries = list(files.items())
    if not args.no_hashes:
        entries.append(('manifest.sha256', listing(files)))
    out = args.out or '%s-%s.amplugin' % (manifest['id'], manifest['version'])
    if os.path.dirname(os.path.abspath(out)):
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    write_zip(out, entries)
    size = os.path.getsize(out)
    if size > MAX_PACKAGE:
        os.remove(out)
        print('the package is %.1f MB; the limit is 20 MB' % (size / 1048576), file=sys.stderr)
        return 1
    print('wrote %s (%.1f KB), unsigned' % (out, size / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
