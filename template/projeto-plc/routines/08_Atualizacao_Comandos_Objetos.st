(* Rotina 8 — arbitragem automática/manual dentro dos objetos atuadores. *)
FBMotor(ComandoAutomatico := MotorPrincipal.ComandoAutomatico, ComandoManual := MotorPrincipal.ComandoManual,
    HabilitaManual := MotorPrincipal.HabilitaSaidaManual,
    PermiteOperacao := ComandoConsolidado.PermissivosOK AND NOT ComandoConsolidado.Trip,
    RetornoLigado := InputsDigitais.RetornoMotor);
FBValvula(ComandoAutomatico := ValvulaSucao.ComandoAutomatico, ComandoManual := ValvulaSucao.ComandoManual,
    HabilitaManual := ValvulaSucao.HabilitaSaidaManual,
    PermiteAbrir := FBMotor.ComandoSaida AND NOT ComandoConsolidado.Trip,
    RetornoAberta := InputsDigitais.RetornoValvulaAberta, RetornoFechada := InputsDigitais.RetornoValvulaFechada);
FBExaustor(ComandoAutomatico := MotorExaustor.ComandoAutomatico, ComandoManual := MotorExaustor.ComandoManual,
    HabilitaManual := MotorExaustor.HabilitaSaidaManual, PermiteOperacao := NOT ComandoConsolidado.Trip,
    RetornoLigado := InputsDigitais.RetornoExaustor);
FBVentilador1(ComandoAutomatico := MotorVentilador1.ComandoAutomatico, ComandoManual := MotorVentilador1.ComandoManual,
    HabilitaManual := MotorVentilador1.HabilitaSaidaManual, PermiteOperacao := NOT ComandoConsolidado.Trip,
    RetornoLigado := InputsDigitais.RetornoVentilador1);
FBVentilador2(ComandoAutomatico := MotorVentilador2.ComandoAutomatico, ComandoManual := MotorVentilador2.ComandoManual,
    HabilitaManual := MotorVentilador2.HabilitaSaidaManual, PermiteOperacao := NOT ComandoConsolidado.Trip,
    RetornoLigado := InputsDigitais.RetornoVentilador2);
