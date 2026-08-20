(* Rotina 4 — processamento encapsulado dos instrumentos. *)
FBPressao(ValorRaw := InputsAnalogicos.PressaoJusanteRaw,
    HabilitaSimulacao := HabilitaSimulacao, ValorSimulado := PressaoJusante.ValorSimulado,
    RangeLow := 0.0, RangeHigh := 10.0, AlarmeLow := 0.2, AlarmeHigh := 9.0);
PressaoJusante.ValorEntrada := InputsAnalogicos.PressaoJusanteRaw;
PressaoJusante.ValorEngenharia := FBPressao.ValorEngenharia;
PressaoJusante.ValorFisico := FBPressao.ValorFisico;
PressaoJusante.StatusAlarmeLow := FBPressao.StatusLow;
PressaoJusante.StatusAlarmeHigh := FBPressao.StatusHigh;
PressaoJusante.Desconectado := FBPressao.Desconectado;
PressaoJusante.StatusAlarmeResumo := FBPressao.StatusLow OR FBPressao.StatusHigh OR FBPressao.Desconectado;

FBTemperatura(ValorRaw := InputsAnalogicos.TemperaturaOleoRaw,
    HabilitaSimulacao := HabilitaSimulacao, ValorSimulado := TemperaturaOleo.ValorSimulado,
    RangeLow := 0.0, RangeHigh := 150.0, AlarmeLow := 5.0, AlarmeHigh := 95.0);
TemperaturaOleo.ValorEngenharia := FBTemperatura.ValorEngenharia;
TemperaturaOleo.StatusAlarmeHigh := FBTemperatura.StatusHigh;
