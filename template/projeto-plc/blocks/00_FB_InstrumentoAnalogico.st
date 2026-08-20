FUNCTION_BLOCK FB_InstrumentoAnalogico
VAR_INPUT
    ValorRaw : INT;
    HabilitaSimulacao : BOOL;
    ValorSimulado : REAL;
    RangeLow : REAL;
    RangeHigh : REAL;
    AlarmeLow : REAL;
    AlarmeHigh : REAL;
END_VAR
VAR_OUTPUT
    ValorEngenharia : REAL;
    ValorFisico : REAL;
    StatusLow : BOOL;
    StatusHigh : BOOL;
    Desconectado : BOOL;
END_VAR

ValorFisico := INT_TO_REAL(ValorRaw) * 20.0 / 32767.0;
Desconectado := (ValorRaw < 0) OR (ValorRaw > 32767);
IF HabilitaSimulacao THEN
    ValorEngenharia := ValorSimulado;
ELSE
    ValorEngenharia := RangeLow + INT_TO_REAL(ValorRaw) * (RangeHigh - RangeLow) / 32767.0;
END_IF;
StatusLow := (ValorEngenharia <= AlarmeLow) AND NOT Desconectado;
StatusHigh := (ValorEngenharia >= AlarmeHigh) AND NOT Desconectado;
END_FUNCTION_BLOCK
