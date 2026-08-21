# Levar a logica para outro CP

O export gera dois arquivos, cada um com um destino.

| saida | uso | conteudo |
|---|---|---|
| `_Aplicacao.xml` | **qualquer software**: CODESYS, Schneider, ABB, WAGO, MasterTool | so a logica, em ST, no formato da norma |
| `_Completo.xml` | voltar ao **mesmo** projeto do fabricante | o original inteiro, diferindo so no corpo das POUs |
| `rotinas/*.st` | colar uma rotina de cada vez, em qualquer IDE | um arquivo por POU, declaracao e corpo |
| `_ST.st` | ler o projeto todo de uma vez | as POUs concatenadas |

As `rotinas/` sao o caminho que sempre funciona: nao dependem de importador nem de
esquema. Cria-se a POU vazia no IDE de destino e cola-se o arquivo.

## Receita, validada no CODESYS 3.5 SP22

1. `bash runtime/export.sh`
2. Copiar `export/<projeto>_Aplicacao.xml`
3. No IDE de destino, **selecionar o `Application` na arvore** — nao a raiz, nao o `Device`
4. Projeto > Importar > Importar PLCopenXML
5. Montar o dispositivo e o mapeamento de I/O a mao, conforme o fabricante

O passo 5 nao tem como ser automatizado: descricao de dispositivo, mapeamento de
I/O e biblioteca de fabricante nao sao portaveis. A propria CODESYS documenta que
biblioteca nao e exportada via PLCopenXML.

## O que foi preciso corrigir para chegar aqui

Cinco defeitos, cada um descoberto pela mensagem do importador depois de corrigir
o anterior. Todos verificados no export.

| defeito | correcao |
|---|---|
| ordem dos filhos de `<pou>`: `body` depois de `addData` | reordena conforme o esquema |
| `<pouInstance typeName="">` vazio | preenche quando existe POU de mesmo nome |
| corpo ST como `<html:xhtml>` | serializa como `<xhtml xmlns="...">` |
| 14 blocos `<data name="Device">` com dump do hardware Nexto, 92% do arquivo | fora do arquivo da aplicacao |
| `ProjectStructure` e 75 `ObjectId` amarrando cada objeto ao GUID do pai | fora do arquivo da aplicacao |
| `VAR_GLOBAL` e `VAR_GLOBAL CONSTANT` na mesma lista, proibido pela norma | lista constante ganha sufixo `_Const` |
| `task` depois de `globalVars` em `<resource>` | `task` primeiro, e a ordem e checada |
| `<vendorElement>` das redes LD sem conteudo apos remover `addData` | aplicacao leva ST em toda POU |

## Por que o arquivo do fabricante nao importa em outro projeto

Nem o MasterTool nem o CODESYS usam `types/pous`: os dois guardam POU e DUT dentro
da extensao `http://www.3s-software.com/plcopenxml/pou` e amarram cada objeto ao
GUID do pai pelo `ProjectStructure`. Isso faz o arquivo deles servir de round-trip
do proprio projeto, nao de intercambio. O arquivo da aplicacao e montado do zero,
sem essa amarracao.

## Verificacao

`runtime/verify_export.py` garante que o `_Completo.xml` difira do original apenas
no texto do corpo das POUs. O export tambem checa a ordem de filhos em `<resource>`
e em cada `<pou>` antes de gravar, e aborta se algo sair fora de sequencia.

## Referencias

- https://content.helpme-codesys.com/en/CODESYS%20Development%20System/_cds_cmd_import_plcopenxml.html
- https://content.helpme-codesys.com/en/CODESYS%20Development%20System/_cds_project_export_import.html
- https://product-help.schneider-electric.com/Machine%20Expert/V1.1/en/SoMMenu/SoMMenu/Project_Menu/Project_Menu-16.htm
