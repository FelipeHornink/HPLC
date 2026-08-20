FUNCTION_BLOCK FB_Motor
VAR_INPUT
    ComandoAutomatico : BOOL;
    ComandoManual : BOOL;
    HabilitaManual : BOOL;
    PermiteOperacao : BOOL;
    RetornoLigado : BOOL;
END_VAR
VAR_OUTPUT
    ComandoSaida : BOOL;
    EmOperacao : BOOL;
    Falha : BOOL;
END_VAR

IF HabilitaManual THEN
    ComandoSaida := ComandoManual AND PermiteOperacao;
ELSE
    ComandoSaida := ComandoAutomatico AND PermiteOperacao;
END_IF;
EmOperacao := ComandoSaida AND RetornoLigado;
Falha := ComandoSaida AND NOT RetornoLigado;
END_FUNCTION_BLOCK
