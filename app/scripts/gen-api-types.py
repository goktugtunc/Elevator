#!/usr/bin/env python3
"""Sunucunun OpenAPI şemasından src/lib/api/schema.ts üretir (npm run gen:api)."""
import json, os, re, sys

SPEC = os.environ.get('TK_OPENAPI', '/tmp/tk-openapi.json')
d = json.load(open(SPEC))
S = d['components']['schemas']

def tsname(ref):
    n = ref.split('/')[-1]
    m = re.fullmatch(r'Page_(\w+?)_', n)
    if m:
        return f'Page<{tsname(m.group(1))}>'
    return n

def ts(sch, indent=2):
    if sch is None:
        return 'unknown'
    if '$ref' in sch:
        return tsname(sch['$ref'])
    if 'anyOf' in sch or 'oneOf' in sch:
        parts = [ts(s, indent) for s in sch.get('anyOf') or sch.get('oneOf')]
        seen = []
        for p in parts:
            if p not in seen:
                seen.append(p)
        return ' | '.join(seen)
    if 'allOf' in sch:
        return ' & '.join(ts(s, indent) for s in sch['allOf'])
    if 'const' in sch:
        return json.dumps(sch['const'])
    if 'enum' in sch:
        return ' | '.join(json.dumps(v) for v in sch['enum'])
    t = sch.get('type')
    if t == 'array':
        inner = ts(sch.get('items'), indent)
        return f'({inner})[]' if '|' in inner else f'{inner}[]'
    if t == 'object':
        ap = sch.get('additionalProperties')
        if isinstance(ap, dict):
            return f'Record<string, {ts(ap, indent)}>'
        if sch.get('properties'):
            return obj_body(sch, indent)
        return 'Record<string, unknown>'
    if t == 'string':
        return 'string'
    if t in ('integer', 'number'):
        return 'number'
    if t == 'boolean':
        return 'boolean'
    if t == 'null':
        return 'null'
    return 'unknown'

def doc(sch, pad):
    desc = sch.get('description')
    if not desc:
        return ''
    one = ' '.join(desc.split())
    if len(one) > 100:
        one = one[:97] + '…'
    return f'{pad}/** {one} */\n'

def obj_body(sch, indent):
    pad = ' ' * indent
    req = set(sch.get('required', []))
    out = '{\n'
    for k, v in sch.get('properties', {}).items():
        opt = '' if k in req else '?'
        key = k if re.fullmatch(r'[A-Za-z_$][\w$]*', k) else json.dumps(k)
        out += doc(v, pad)
        out += f'{pad}{key}{opt}: {ts(v, indent + 2)};\n'
    out += ' ' * (indent - 2) + '}'
    return out

SKIP = re.compile(r'^(Admin|Indexer|SetFees|SetPaused|SetRouter|SetSettleSlippage|SetToken|AssetSync|HTTPValidationError|ValidationError)')

lines = [
    '/* eslint-disable */',
    '// Bu dosya üretildi — elle düzenlemeyin.',
    '// Kaynak: https://mobilback.yolalapp.com/openapi.json',
    '// Yeniden üretmek için: npm run gen:api',
    '',
    '/** Sunucunun sayfalı yanıt zarfı (`Page[T]`) — offset tabanlı, cursor yok. */',
    'export interface Page<T> {',
    '  items: T[];',
    '  total: number;',
    '  limit: number;',
    '  offset: number;',
    '}',
    '',
]

page_shapes = set()
for name in sorted(S):
    if SKIP.match(name):
        continue
    m = re.fullmatch(r'Page_(\w+?)_', name)
    if m:
        page_shapes.add(name)
        continue
    sch = S[name]
    body_doc = doc(sch, '')
    if 'enum' in sch and sch.get('type') == 'string':
        lines.append(body_doc + f'export type {name} = ' + ' | '.join(json.dumps(v) for v in sch['enum']) + ';')
        lines.append('')
        continue
    if sch.get('type') == 'object' or 'properties' in sch:
        lines.append(body_doc + f'export interface {name} ' + obj_body(sch, 2))
        lines.append('')
    else:
        lines.append(body_doc + f'export type {name} = {ts(sch)};')
        lines.append('')

# Page_X_ zarfları tek bir generic Page<T>'ye indirgenir; alanları beklenenden
# farklıysa (items/total/limit/offset) uyar.
EXPECTED = {'items', 'total', 'limit', 'offset'}
for name in sorted(page_shapes):
    props = set(S[name].get('properties', {}))
    if props != EXPECTED:
        print(f'UYARI {name}: beklenmeyen alanlar {sorted(props)}', file=sys.stderr)

open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src/lib/api/schema.ts'), 'w').write('\n'.join(lines))
print('yazıldı:', sum(1 for l in lines if l.startswith('export')), 'tip')
