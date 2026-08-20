(* Rotina 6 — núcleo decisório; trip possui prioridade absoluta. *)
StatusMaquina.PrimeiroCiclo := StatusMaquina.EstadoAtual <> EstadoAnteriorLocal;
IF StatusMaquina.PrimeiroCiclo THEN
    StatusMaquina.EstadoAnterior := EstadoAnteriorLocal;
    EstadoAnteriorLocal := StatusMaquina.EstadoAtual;
END_IF;
TemporizadorEstado(IN := NOT StatusMaquina.PrimeiroCiclo, PT := TempoMinimoEstado);
StatusMaquina.TempoNoEstado := TemporizadorEstado.ET;
EstadoLiberado := (TempoMinimoEstado = T#0ms) OR TemporizadorEstado.Q;

IF ComandoConsolidado.Trip AND (StatusMaquina.EstadoAtual <> 100) THEN
    StatusMaquina.EstadoOrigemTrip := StatusMaquina.EstadoAtual;
    StatusMaquina.EstadoAtual := 100;
    TotalTrips := TotalTrips + 1;
ELSIF ComandoConsolidado.Desliga AND (StatusMaquina.EstadoAtual <> 100) THEN
    StatusMaquina.EstadoAtual := 0;
ELSE
    CASE StatusMaquina.EstadoAtual OF
        0:
            IF ComandoConsolidado.Liga AND ComandoConsolidado.PermissivosOK THEN StatusMaquina.EstadoAtual := 1; END_IF;
        1:
            IF NOT ComandoConsolidado.PermissivosOK THEN
                StatusMaquina.EstadoAtual := 0;
            ELSIF EstadoLiberado THEN
                StatusMaquina.EstadoAtual := 10;
            END_IF;
        10:
            IF EstadoLiberado THEN StatusMaquina.EstadoAtual := 20; TotalPartidas := TotalPartidas + 1; END_IF;
        11:
            IF NOT Comandos.IHMModoManutencao THEN StatusMaquina.EstadoAtual := 0; END_IF;
        20:
            IF Comandos.IHMAlivioManual THEN
                StatusMaquina.EstadoAtual := 40;
            ELSIF (PressaoJusante.ValorEngenharia <= SetpointCarga) AND EstadoLiberado THEN
                StatusMaquina.EstadoAtual := 30;
            END_IF;
        30:
            IF Comandos.IHMAlivioManual THEN
                StatusMaquina.EstadoAtual := 40;
            ELSIF (PressaoJusante.ValorEngenharia >= SetpointAlivio) AND EstadoLiberado THEN
                StatusMaquina.EstadoAtual := 20;
            END_IF;
        40:
            IF NOT Comandos.IHMAlivioManual AND EstadoLiberado THEN StatusMaquina.EstadoAtual := 20; END_IF;
        100:
            IF ComandoConsolidado.Reset AND NOT ComandoConsolidado.Trip THEN StatusMaquina.EstadoAtual := 0; END_IF;
    ELSE
        StatusMaquina.EstadoAtual := 100;
    END_CASE;
END_IF;
IF Comandos.IHMModoManutencao AND (StatusMaquina.EstadoAtual = 0) THEN StatusMaquina.EstadoAtual := 11; END_IF;
StatusMaquina.ProximoEstado := StatusMaquina.EstadoAtual;
