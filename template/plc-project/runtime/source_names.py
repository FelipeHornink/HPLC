"""Rewrites only ST code; keeps strings and nested comments intact."""
import re


def map_code(text, transform):
    out, start, i = [], 0, 0
    while i < len(text):
        if text.startswith('//', i):
            end = text.find('\n', i)
            if end < 0: end = len(text)
        elif text.startswith('(*', i):
            depth, end = 1, i + 2
            while end < len(text) and depth:
                if text.startswith('(*', end): depth += 1; end += 2
                elif text.startswith('*)', end): depth -= 1; end += 2
                else: end += 1
            if depth: raise ValueError('Unterminated ST comment')
        elif text[i] in "'\"":
            quote, end = text[i], i + 1
            while end < len(text):
                if text[end] == '$': end += 2
                elif text[end] == quote:
                    end += 1
                    if end < len(text) and text[end] == quote: end += 1
                    else: break
                else: end += 1
            else: raise ValueError('Unterminated ST string')
        else:
            i += 1
            continue
        out.extend([transform(text[start:i]), text[i:end]])
        start = i = end
    out.append(transform(text[start:]))
    return ''.join(out)


def restore_names(text, entries):
    reverse = {f"{e.get('prefix') or e['name'] + '_'}{m}".upper(): f"{e['name']}.{m}"
               for e in entries for m in e.get('members', [])}
    pattern = re.compile(r'(?<![.\w])[A-Za-z_]\w*')
    return map_code(text, lambda code: pattern.sub(lambda m: reverse.get(m.group().upper(), m.group()), code))
