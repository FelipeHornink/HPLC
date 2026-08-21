#!/usr/bin/env python3
"""Verifica que o XML exportado difere do original apenas no corpo das POUs.

Sem isso a unica forma de saber se o arquivo importa no MasterTool ou no
CODESYS era tentar e olhar a tela. O contrato e simples: se o original
importa, um arquivo que difere dele so no texto de <xhtml> tambem importa.

    python3 runtime/verify_export.py plcopen/original.xml export/*_PLC_Codex.xml
"""
import sys
import xml.etree.ElementTree as ET
from collections import Counter

def local(e): return e.tag.split("}")[-1]

def caminho_de(root):
    """Assinatura de cada elemento: caminho + atributos identificadores."""
    mapa = {}
    def desce(no, prefixo):
        contador = Counter()
        for filho in no:
            nome = local(filho)
            chave = filho.get("name") or filho.get("Name") or filho.get("typeName")
            if chave is None:
                contador[nome] += 1
                rotulo = f"{nome}[{contador[nome]}]"
            else:
                rotulo = f"{nome}:{chave}"
            caminho = f"{prefixo}/{rotulo}"
            mapa[caminho] = filho
            desce(filho, caminho)
    desce(root, "")
    return mapa

a = caminho_de(ET.parse(sys.argv[1]).getroot())
b = caminho_de(ET.parse(sys.argv[2]).getroot())
so_original = sorted(set(a) - set(b))
so_exportado = sorted(set(b) - set(a))
atributos = []
texto = []
for chave in sorted(set(a) & set(b)):
    if a[chave].attrib != b[chave].attrib:
        atributos.append((chave, a[chave].attrib, b[chave].attrib))
    ta, tb = (a[chave].text or "").strip(), (b[chave].text or "").strip()
    if ta != tb:
        texto.append(chave)

print(f"elementos so no ORIGINAL:  {len(so_original)}")
print(f"elementos so no EXPORTADO: {len(so_exportado)}")
print(f"atributos diferentes:      {len(atributos)}")
print(f"texto diferente:           {len(texto)}")

def resumo(lista, titulo, limite=12):
    if not lista: return
    print(f"\n--- {titulo} ---")
    grupos = Counter("/".join(c.split("/")[:4]) for c in lista)
    for grupo, n in grupos.most_common(limite):
        print(f"  {n:5d}  {grupo}")

resumo(so_original, "so no original")
resumo(so_exportado, "so no exportado")
if atributos:
    print("\n--- atributos (5 primeiros) ---")
    for c, x, y in atributos[:5]: print(f"  {c}\n     original: {x}\n     exportado: {y}")
if texto:
    print(f"\n--- texto diferente: {len(texto)} elementos ---")
    grupos = Counter(c.split("/")[-1].split(":")[0] for c in texto)
    for g, n in grupos.most_common(): print(f"  {n:5d}  {g}")

falhou = bool(so_original or so_exportado or atributos) or any(
    c.split("/")[-1].split("[")[0] != "xhtml" for c in texto)
print()
if falhou:
    print("FALHOU: o exportado difere do original fora do corpo das POUs.")
    sys.exit(1)
print(f"OK: diferenca restrita ao corpo de {len(texto)} POUs.")
