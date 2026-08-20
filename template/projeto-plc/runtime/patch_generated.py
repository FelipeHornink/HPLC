#!/usr/bin/env python3
"""Contorno de bug no C++ gerado pelo STruC++ 0.6.3.

Ele declara variavel dentro de corpo de case sem abrir chaves, e o C++ trata
isso como salto sobre inicializacao:

    error: jump to case label
    note: crosses initialization of 'bool __gwv_26'

Cada rotulo de case passa a ter corpo entre chaves. O codigo gerado tem
indentacao regular, entao o corpo do rotulo vai ate a proxima linha com
indentacao menor ou igual a dele. Remover quando o compilador corrigir.
"""
from pathlib import Path
import re
import sys

alvo = Path(sys.argv[1])
linhas = alvo.read_text(encoding="utf-8").splitlines()
rotulo = re.compile(r"^(\s*)(case\s+[^:]+:|default:)\s*$")
saida = []
aberto = None  # indentacao do rotulo com corpo aberto
ajustes = 0

for linha in linhas:
    recuo = len(linha) - len(linha.lstrip())
    conteudo = linha.strip()
    if aberto is not None and conteudo and recuo <= aberto:
        saida.append(" " * aberto + "}")
        aberto = None
    match = rotulo.match(linha)
    if match:
        saida.append(f"{match.group(1)}{match.group(2)} {{")
        aberto = len(match.group(1))
        ajustes += 1
        continue
    saida.append(linha)

if aberto is not None:
    saida.append(" " * aberto + "}")
alvo.write_text("\n".join(saida) + "\n", encoding="utf-8")
print(f"Contorno de case aplicado em {ajustes} rotulos de {alvo.name}")
