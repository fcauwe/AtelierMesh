#!/usr/bin/env python3
"""Static checks of an AtelierMesh plugin with Python 3 only (no Node, no npm).

    python3 amplugin_check.py <plugin folder>        manifest shape, source rules, fixtures.json, locales/
    python3 amplugin_check.py <file.amplugin>        the package: entries, manifest.sha256 against the files, manifest and main.js

WHAT THIS CANNOT DO: it cannot run your plugin (that needs JavaScript). So it does not test determinism, cancelling, closed solids or fixture results.
When Node is available, run `node amplugin.mjs check <folder>` once: that is the complete check. Exit code 0 = no failures, 1 = at least one.
Part of the AtelierMesh plugin kit.
"""
import hashlib
import json
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from amplugin_pack import OP_ID, PLUGIN_ID, SEMVER, listing, locale_problems, scan  # noqa: E402

PARAM_TYPES = ['bool', 'int', 'float', 'string', 'enum', 'vector', 'angle', 'asset', 'payload', 'placement', 'part', 'range', 'selection', 'list', 'color', 'object']
KINDS = ['generator', 'modifier', 'analyzer', 'exporter']
PERSONALISABLE = ['never', 'optional', 'always']
NO_DEFAULT = ['placement', 'selection', 'list', 'object']

rows = []


def add(status, text, detail=''):
    rows.append((status, text, detail))


def flat(d, prefix=''):
    out = set()
    for k, v in d.items():
        out |= flat(v, prefix + k + '.') if isinstance(v, dict) else {prefix + k}
    return out


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



def check_manifest(m):
    if not isinstance(m, dict):
        add('FAIL', 'manifest.json holds one JSON object')
        return False
    ok = True

    def need(cond, text):
        nonlocal ok
        if not cond:
            ok = False
            add('FAIL', 'manifest: ' + text)
    need(m.get('manifest_version') == 1, 'manifest_version must be 1')
    need(isinstance(m.get('id'), str) and bool(PLUGIN_ID.match(m.get('id', ''))), 'id must look like com.example.my_plugin')
    need(isinstance(m.get('name'), str) and bool(m.get('name')), 'name is missing')
    need(isinstance(m.get('version'), str) and bool(SEMVER.match(m.get('version', ''))), 'version must look like 1.0.0')
    for text in metadata_problems(m):
        need(False, text)
    ops = m.get('operations')
    need(isinstance(ops, list) and len(ops) > 0, 'operations must be a non-empty list')
    if not isinstance(ops, list):
        return False
    seen = set()
    for op in ops:
        if not isinstance(op, dict):
            need(False, 'an operation must be an object')
            continue
        oid = op.get('id')
        need(isinstance(oid, str) and bool(OP_ID.match(oid or '')), 'operation id %r must be lowercase letters, digits and underscores' % (oid,))
        need(oid not in seen, 'operation id %r is used twice' % (oid,))
        seen.add(oid)
        need(op.get('kind') in KINDS, '%s: kind must be one of %s' % (oid, ', '.join(KINDS)))
        pl = op.get('payload')
        if pl is not None:
            need(isinstance(pl, dict) and all(pl.get(k) is None or (isinstance(pl.get(k), str) and (pl.get(k) == '*' or bool(OP_ID.match(pl.get(k))))) for k in ('in', 'out')),
                 '%s: payload is {"in": "drawing", "out": "mesh"}: each a kind word (lowercase letters, digits and underscores)' % oid)
        need(op.get('personalisable', 'never') in PERSONALISABLE, '%s: personalisable must be never, optional or always' % oid)
        sections = {s.get('id') for s in op.get('sections', []) if isinstance(s, dict)}
        names = set()
        params = op.get('params')
        need(isinstance(params, list), '%s: params must be a list (it may be empty)' % oid)
        for p in params if isinstance(params, list) else []:
            if not isinstance(p, dict):
                need(False, '%s: a setting must be an object' % oid)
                continue
            pn = p.get('name')
            need(isinstance(pn, str) and bool(OP_ID.match(pn or '')), '%s: setting name %r must be lowercase letters, digits and underscores' % (oid, pn))
            need(pn not in names, '%s: setting %r is used twice' % (oid, pn))
            names.add(pn)
            t = p.get('type')
            need(t in PARAM_TYPES, '%s.%s: type %r is not one of %s' % (oid, pn, t, ', '.join(PARAM_TYPES)))
            if t not in NO_DEFAULT:
                need('default' in p, '%s.%s: default is missing' % (oid, pn))
            if t == 'enum':
                opts = [o.get('value') if isinstance(o, dict) else o for o in p.get('options', [])] if isinstance(p.get('options'), list) else []
                need(len(opts) > 0, '%s.%s: an enum needs options' % (oid, pn))
                need(p.get('default') in opts, '%s.%s: default %r is not one of the options' % (oid, pn, p.get('default')))
            if t == 'payload':
                acc = p.get('accept')
                need(isinstance(acc, list) and len(acc) > 0 and all(isinstance(k, str) and (k == '*' or bool(OP_ID.match(k))) for k in acc),
                     '%s.%s: a payload setting needs accept: a list of kinds, for example ["drawing"]' % (oid, pn))
                need(p.get('default') is None or (isinstance(p.get('default'), str) and bool(OP_ID.match(p.get('default')))),
                     '%s.%s: default is the name of a stored item (lowercase letters, digits and underscores) or null' % (oid, pn))
            if t in ('int', 'float', 'angle') and isinstance(p.get('default'), (int, float)):
                lo, hi = p.get('min'), p.get('max')
                if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
                    need(lo <= hi, '%s.%s: min is above max' % (oid, pn))
                if isinstance(lo, (int, float)):
                    need(p['default'] >= lo, '%s.%s: default %s is below min %s' % (oid, pn, p['default'], lo))
                if isinstance(hi, (int, float)):
                    need(p['default'] <= hi, '%s.%s: default %s is above max %s' % (oid, pn, p['default'], hi))
            if p.get('section') is not None:
                need(p['section'] in sections, '%s.%s: section %r is not declared in sections' % (oid, pn, p['section']))
            if p.get('visible_if') is not None:
                need(isinstance(p['visible_if'], str), '%s.%s: visible_if is a text like "mode == \'copy\'"' % (oid, pn))
        if op.get('personalisable') == 'never':
            flagged = [p.get('name') for p in params if isinstance(p, dict) and p.get('personalisable') is True] if isinstance(params, list) else []
            need(not flagged, '%s: personalisable is "never" but %s is marked personalisable' % (oid, ', '.join(map(str, flagged))))
    if ok:
        if not (isinstance(m.get('contact'), dict) and (m['contact'].get('url') or m['contact'].get('email'))):
            add('note', 'no contact details (optional): add "contact": {"url": "https://...", "email": "you@example.org"} so users can reach you')
        if 'package_url' not in m:
            add('note', 'no "package_url" (optional): add the https address where the packed .amplugin will be published, so users can check for updates')
        add('ok', 'the manifest has the right shape (%s %s, %d operation%s)' % (m['id'], m['version'], len(ops), '' if len(ops) == 1 else 's'))
    return ok


def check_fixtures(path, manifest):
    try:
        with open(path, encoding='utf-8') as f:
            fixtures = json.load(f)
    except ValueError as e:
        add('FAIL', 'fixtures.json is valid JSON', str(e))
        return
    if not isinstance(fixtures, list):
        add('FAIL', 'fixtures.json is a list')
        return
    ops = {o['id']: o for o in manifest.get('operations', []) if isinstance(o, dict) and 'id' in o}
    bad = 0
    for i, fx in enumerate(fixtures):
        label = fx.get('name', 'fixture %d' % (i + 1)) if isinstance(fx, dict) else 'fixture %d' % (i + 1)
        if not isinstance(fx, dict):
            add('FAIL', 'fixtures.json: %s is an object' % label)
            bad += 1
            continue
        steps = fx.get('steps') or ([{'operation': fx.get('operation'), 'params': fx.get('params', {})}] if fx.get('operation') else [])
        if not steps:
            add('FAIL', 'fixtures.json: "%s" names an operation (or steps)' % label)
            bad += 1
        for s in steps:
            op = ops.get(s.get('operation'))
            if op is None:
                add('FAIL', 'fixtures.json: "%s" uses an operation that is not in the manifest: %r' % (label, s.get('operation')))
                bad += 1
                continue
            known = {p.get('name') for p in op.get('params', []) if isinstance(p, dict)}
            for k in (s.get('params') or {}):
                if k not in known:
                    add('FAIL', 'fixtures.json: "%s" sets %r, which %s has no setting for' % (label, k, op['id']))
                    bad += 1
        if not isinstance(fx.get('expect'), dict):
            add('FAIL', 'fixtures.json: "%s" has an expect object' % label)
            bad += 1
    if bad == 0:
        add('ok', 'fixtures.json is well formed (%d fixture%s; to RUN them, use the Node check)' % (len(fixtures), '' if len(fixtures) == 1 else 's'))


def check_locale_rules(base, manifest):
    """The limits and the namespace rule the loader applies (SPEC.md section 4); a host leaves out everything that breaks the namespace rule."""
    for text in locale_problems(os.path.dirname(base), manifest):
        add('FAIL', 'locales/: ' + text)


def check_locales(folder, manifest=None):
    base = os.path.join(folder, 'locales')
    if not os.path.isdir(base):
        add('note', 'no locales/ folder: add en.json, nl.json and fr.json with the plugin\'s texts')
        return
    keys = {}
    for lang in ('en', 'nl', 'fr'):
        p = os.path.join(base, lang + '.json')
        if not os.path.isfile(p):
            add('FAIL', 'locales/%s.json exists' % lang)
            continue
        try:
            with open(p, encoding='utf-8') as f:
                keys[lang] = flat(json.load(f))
        except ValueError as e:
            add('FAIL', 'locales/%s.json is valid JSON' % lang, str(e))
    if manifest is not None:
        check_locale_rules(base, manifest)
    if len(keys) == 3:
        for lang in ('nl', 'fr'):
            missing, extra = sorted(keys['en'] - keys[lang]), sorted(keys[lang] - keys['en'])
            if missing or extra:
                add('FAIL', 'locales/%s.json has the same keys as en.json' % lang, ('missing: ' + ', '.join(missing[:8]) + '\n' if missing else '') + ('not in en: ' + ', '.join(extra[:8]) if extra else ''))
            else:
                add('ok', 'locales/%s.json has the same %d keys as en.json' % (lang, len(keys['en'])))


def check_folder(folder):
    mf = os.path.join(folder, 'manifest.json')
    if not os.path.isfile(mf):
        add('FAIL', 'manifest.json exists in %s' % folder)
        return
    try:
        with open(mf, encoding='utf-8') as f:
            manifest = json.load(f)
    except ValueError as e:
        add('FAIL', 'manifest.json is valid JSON', str(e))
        return
    ok = check_manifest(manifest)
    if ok and isinstance(manifest.get('image'), dict) and image_path_ok(manifest['image'].get('file')):
        ip = os.path.join(folder, manifest['image']['file'])
        if os.path.isfile(ip):
            with open(ip, 'rb') as f:
                why = image_problem(manifest, {manifest['image']['file']: f.read()})
            add('FAIL' if why else 'ok', why or 'the example picture is a usable PNG, JPEG or WebP')
        else:
            add('FAIL', 'the example picture %s exists in the folder' % manifest['image']['file'])
    main = os.path.join(folder, 'main.js')
    if not os.path.isfile(main):
        add('FAIL', 'main.js exists (this tool reads plain JavaScript only)')
    else:
        with open(main, encoding='utf-8') as f:
            found = scan(f.read())
        if found:
            for line, why, text in found:
                add('FAIL', 'main.js line %d: %s' % (line, why), text)
        else:
            add('ok', 'main.js follows the rules: no random numbers, no clock, no network, no eval, no imports')
    if ok and os.path.isfile(os.path.join(folder, 'fixtures.json')):
        check_fixtures(os.path.join(folder, 'fixtures.json'), manifest)
    elif ok:
        add('note', 'no fixtures.json: add a few with expected sizes, volumes and error codes')
    check_locales(folder, manifest)


def check_package(path):
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        add('FAIL', 'the file is a ZIP', str(e))
        return
    names = [n for n in z.namelist() if not n.endswith('/')]
    files = {n: z.read(n) for n in names}
    for n in names:
        if n.startswith('/') or '\\' in n or '..' in n.split('/'):
            add('FAIL', 'entry names are safe: %r' % n)
    for need in ('manifest.json', 'main.js'):
        add('ok' if need in files else 'FAIL', 'the package has %s' % need)
    if 'manifest.json' in files:
        try:
            check_manifest(json.loads(files['manifest.json'].decode('utf-8')))
        except ValueError as e:
            add('FAIL', 'manifest.json inside the package is valid JSON', str(e))
    if 'manifest.json' in files:
        try:
            mf = json.loads(files['manifest.json'].decode('utf-8'))
            if isinstance(mf, dict) and 'image' in mf:
                why = image_problem(mf, files)
                add('FAIL' if why else 'ok', why or 'the example picture is a usable PNG, JPEG or WebP')
            elif isinstance(mf, dict):
                add('note', 'no "image" (optional): an example picture (assets/example.png, 640 x 420 px) shows in the plugin gallery')
        except ValueError:
            pass
    if 'main.js' in files:
        found = scan(files['main.js'].decode('utf-8'))
        for line, why, text in found:
            add('FAIL', 'main.js line %d: %s' % (line, why), text)
        if not found:
            add('ok', 'main.js follows the rules')
    if 'manifest.sha256' in files:
        want = files['manifest.sha256']
        have = listing(files)
        if want == have:
            add('ok', 'manifest.sha256 lists every file with the right sha256')
        else:
            wl, hl = set(want.decode('utf-8').splitlines()), set(have.decode('utf-8').splitlines())
            add('FAIL', 'manifest.sha256 matches the files', 'listed but different or missing: %s\nin the package but not listed: %s' % (sorted(wl - hl)[:4], sorted(hl - wl)[:4]))
    else:
        add('note', 'no manifest.sha256 (the host accepts that, but a listing protects against damage)')
    add('note', 'signed: %s' % ('yes (manifest.sig is present: verify it with `node amplugin.mjs verify`)' if 'manifest.sig' in files else 'no'))
    add('ok', 'sha256 of the package file: ' + hashlib.sha256(open(path, 'rb').read()).hexdigest())


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__)
        return 2
    target = argv[0]
    if os.path.isdir(target):
        check_folder(target)
    elif os.path.isfile(target):
        check_package(target)
    else:
        print('%s is not a folder or a file' % target, file=sys.stderr)
        return 2
    for status, text, detail in rows:
        print('%-5s %s' % (status, text))
        if detail:
            print('      ' + detail.replace('\n', '\n      '))
    failed = sum(1 for r in rows if r[0] == 'FAIL')
    print('\n%d passed, %d failed, %d note(s)    (static checks only: this tool does not run the plugin; run `node amplugin.mjs check` where Node exists)' % (
        sum(1 for r in rows if r[0] == 'ok'), failed, sum(1 for r in rows if r[0] == 'note')))
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
