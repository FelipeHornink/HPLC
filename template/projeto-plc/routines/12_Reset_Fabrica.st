(* Rotina 12 — restauração autenticada dos parâmetros retentivos. *)
IF SolicitaResetFabrica THEN
    SetpointCarga := 5.5;
    SetpointAlivio := 8.0;
    SolicitaResetFabrica := FALSE;
END_IF;
