(* Rotina 10 — transferência dos comandos consolidados para as saídas físicas. *)
OutputsDigitais.LigaAuxiliares := (StatusMaquina.EstadoAtual = 10) OR FBMotor.ComandoSaida;
OutputsDigitais.LigaMotorPrincipal := FBMotor.ComandoSaida;
OutputsDigitais.LigaExaustor := FBExaustor.ComandoSaida;
OutputsDigitais.LigaVentilador1 := FBVentilador1.ComandoSaida;
OutputsDigitais.LigaVentilador2 := FBVentilador2.ComandoSaida;
OutputsDigitais.LigaResistenciaAquecimento := (TemperaturaOleo.ValorEngenharia < 40.0) AND NOT ComandoConsolidado.Trip;
OutputsDigitais.AbreValvulaSucao := FBValvula.ComandoSaida;
