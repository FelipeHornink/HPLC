(* Rotina 7 — última barreira lógica antes da atuação física. *)
MotorPrincipal.ComandoAutomatico := (StatusMaquina.EstadoAtual = 20) OR (StatusMaquina.EstadoAtual = 30) OR (StatusMaquina.EstadoAtual = 40);
ValvulaSucao.ComandoAutomatico := StatusMaquina.EstadoAtual = 30;
MotorExaustor.ComandoAutomatico := (StatusMaquina.EstadoAtual = 10) OR StatusMaquina.EmOperacao;
MotorVentilador1.ComandoAutomatico := (StatusMaquina.EstadoAtual = 10) OR StatusMaquina.EmOperacao;
MotorVentilador2.ComandoAutomatico := (StatusMaquina.EstadoAtual = 10) OR StatusMaquina.EmOperacao;
