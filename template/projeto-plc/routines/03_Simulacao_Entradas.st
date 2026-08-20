(* Rotina 3 — modelo físico simplificado usado exclusivamente em bancada. *)
IF HabilitaSimulacao THEN
    InputsDigitais.RetornoMotor := OutputsDigitais.LigaMotorPrincipal;
    InputsDigitais.RetornoExaustor := OutputsDigitais.LigaExaustor;
    InputsDigitais.RetornoVentilador1 := OutputsDigitais.LigaVentilador1;
    InputsDigitais.RetornoVentilador2 := OutputsDigitais.LigaVentilador2;
    InputsDigitais.RetornoValvulaAberta := OutputsDigitais.AbreValvulaSucao;
    InputsDigitais.RetornoValvulaFechada := NOT OutputsDigitais.AbreValvulaSucao;
    IF OutputsDigitais.LigaMotorPrincipal AND OutputsDigitais.AbreValvulaSucao THEN
        PressaoJusante.ValorSimulado := PressaoJusante.ValorSimulado + 0.02;
    ELSE
        PressaoJusante.ValorSimulado := PressaoJusante.ValorSimulado - 0.03;
    END_IF;
    IF PressaoJusante.ValorSimulado < 0.0 THEN PressaoJusante.ValorSimulado := 0.0; END_IF;
    IF PressaoJusante.ValorSimulado > 10.0 THEN PressaoJusante.ValorSimulado := 10.0; END_IF;
    TemperaturaOleo.ValorSimulado := 35.0 + PressaoJusante.ValorSimulado * 4.0;
    PIT700.ValorEngenharia := PressaoJusante.ValorSimulado * 0.92;
    PIT701.ValorEngenharia := PressaoJusante.ValorSimulado * 0.96;
    PIT702.ValorEngenharia := PressaoJusante.ValorSimulado * 0.98;
    PIT703.ValorEngenharia := PressaoJusante.ValorSimulado;
    PIT704.ValorEngenharia := PressaoJusante.ValorSimulado + 0.15;
    PIT705.ValorEngenharia := PressaoJusante.ValorSimulado + 0.08;
    TIT700.ValorEngenharia := TemperaturaOleo.ValorSimulado;
    TIT701.ValorEngenharia := TemperaturaOleo.ValorSimulado + 2.0;
    TIT702.ValorEngenharia := TemperaturaOleo.ValorSimulado - 3.0;
    TIT703.ValorEngenharia := 32.0 + PressaoJusante.ValorSimulado * 2.0;
    TIT704.ValorEngenharia := 30.0 + PressaoJusante.ValorSimulado * 1.5;
END_IF;
