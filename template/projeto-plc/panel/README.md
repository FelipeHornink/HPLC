# Configuração da tela do equipamento

Edite `painel.json` pelo comando **PLC Codex: Configurar Tela e Mapeamento**.
A página lê este arquivo ao abrir; não é necessário recompilar o PLC.

A bancada não possui macro de preparação: cada tag é comandada individualmente.
Entradas DI/AI permanecem no valor escrito até o usuário ou o ST alterá-las.
Saídas DO/AO também aceitam escrita de teste, mas normalmente o próximo scan do
programa as sobrescreve.

## Áreas

- `monitoring`: faixa superior para estados e variáveis internas de operação.
- `ihm`: comandos e valores mostrados no clone da IHM.
- `panel`: DI de botoeiras/chaves da porta e DO de sinaleiros.
- `interface`: DI/AI recebidos do cliente e DO/AO enviados ao cliente.
- `field`: sensores DI/AI e atuadores DO/AO instalados no equipamento.

## Widgets

- `momentary`: botão de pulso. Em pausa permanece pressionado até o scan ou novo clique.
- `toggle`: chave BOOL mantida.
- `lamp`: indicação BOOL somente leitura.
- `analog`: valor numérico editável.
- `number`: valor numérico editável ou somente leitura conforme `writable`.

Itens da área `ihm` aceitam também `"tab": "Nome da aba"`. Assim uma mesma
IHM pode ter abas como Operação, Parâmetros e Diagnóstico sem criar HTML.

Itens numéricos podem usar `"valueLabels": {"0":"S0 · Desligado"}` para
mostrar uma descrição operacional sem alterar o valor real recebido do PLC.

`display.realPrecision` define a quantidade padrão de casas decimais para
`REAL/LREAL`. Cada item pode sobrescrever o padrão com `"precision": 1`, por
exemplo. A formatação altera somente a apresentação; o valor do PLC não é
arredondado internamente. `display.theme` aceita `"light"` ou `"dark"` como tema
inicial, e o usuário pode alternar o tema no cabeçalho.

Use `ioType` para identificar visualmente `DI`, `DO`, `AI`, `AO`, `IHM` ou
`INTERNO`. O campo `address` mostra o canal físico ou lógico correspondente.

Exemplo:

```json
{
  "tag": "InputsDigitais.PermissivoCliente",
  "label": "Permissivo cliente",
  "kind": "toggle",
  "address": "DI-08",
  "writable": true
}
```

A `tag` precisa existir em **Depuração ao vivo**. Se o programa escrever na
mesma variável a cada scan, a escrita manual será visível imediatamente e depois
poderá ser sobrescrita pela lógica; use **Forçar** quando precisar mantê-la.

## Visão P&ID

`pid.html` é servido numa porta separada e `pid.json` escolhe as variáveis e suas
posições percentuais (`x` e `y`). Essa página é somente visualização do processo;
o desenho provisório poderá ser substituído futuramente pela imagem real do P&ID.
