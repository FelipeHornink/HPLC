VAR_GLOBAL
    Comandos : ST_Comandos;
    ComandoConsolidado : ST_ComandoConsolidado;
    StatusMaquina : ST_StatusMaquina;
    SetpointCarga : REAL := 5.5;
    SetpointAlivio : REAL := 8.0;
    (* Simulação rápida: cada transição pode ocorrer no próximo scan de 10 ms. *)
    TempoMinimoEstado : TIME := T#0ms;
END_VAR
