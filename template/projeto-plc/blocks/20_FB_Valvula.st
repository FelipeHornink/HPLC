FUNCTION_BLOCK FB_Valvula
VAR_INPUT
    ComandoAutomatico : BOOL;
    ComandoManual : BOOL;
    HabilitaManual : BOOL;
    PermiteAbrir : BOOL;
    RetornoAberta : BOOL;
    RetornoFechada : BOOL;
END_VAR
VAR_OUTPUT
    ComandoSaida : BOOL;
    Aberta : BOOL;
    Fechada : BOOL;
    Falha : BOOL;
END_VAR

IF HabilitaManual THEN
    ComandoSaida := ComandoManual AND PermiteAbrir;
ELSE
    ComandoSaida := ComandoAutomatico AND PermiteAbrir;
END_IF;
Aberta := RetornoAberta;
Fechada := RetornoFechada;
Falha := RetornoAberta AND RetornoFechada;
END_FUNCTION_BLOCK
