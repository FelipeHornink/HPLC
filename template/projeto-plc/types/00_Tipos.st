TYPE ST_EntradasDigitais :
STRUCT
    BotaoLiga : BOOL;
    BotaoDesliga : BOOL;
    BotaoReset : BOOL;
    EmergenciaSaudavel : BOOL;
    PermissivoCliente : BOOL;
    SeletorLocalRemoto : BOOL;
    ClienteStart : BOOL;
    ClienteStop : BOOL;
    ClienteEmergencia : BOOL;
    RetornoMotor : BOOL;
    RetornoExaustor : BOOL;
    RetornoVentilador1 : BOOL;
    RetornoVentilador2 : BOOL;
    TripExterno : BOOL;
    RetornoValvulaAberta : BOOL;
    RetornoValvulaFechada : BOOL;
    LSH : BOOL;
END_STRUCT;
END_TYPE

TYPE ST_EntradasAnalogicas :
STRUCT
    PressaoJusanteRaw : INT;
    TemperaturaOleoRaw : INT;
END_STRUCT;
END_TYPE

TYPE ST_SaidasDigitais :
STRUCT
    LigaAuxiliares : BOOL;
    LigaMotorPrincipal : BOOL;
    LigaExaustor : BOOL;
    LigaVentilador1 : BOOL;
    LigaVentilador2 : BOOL;
    LigaResistenciaAquecimento : BOOL;
    AbreValvulaSucao : BOOL;
    SinaleiroPronto : BOOL;
    SinaleiroLigado : BOOL;
    SinaleiroFalha : BOOL;
    ClienteResumoAlarme : BOOL;
    ClienteResumoTrip : BOOL;
    ClienteModoRemoto : BOOL;
    ClientePermissivoPartida : BOOL;
    ClienteFalhaFonte : BOOL;
END_STRUCT;
END_TYPE

TYPE ST_InstrumentoAnalogico :
STRUCT
    ValorEntrada : INT;
    ValorEngenharia : REAL;
    ValorFisico : REAL;
    RangeLow : REAL;
    RangeHigh : REAL;
    HabilitaSimulacao : BOOL;
    ValorSimulado : REAL;
    AlarmeLow : REAL;
    AlarmeHigh : REAL;
    StatusAlarmeLow : BOOL;
    StatusAlarmeHigh : BOOL;
    Desconectado : BOOL;
    StatusAlarmeResumo : BOOL;
END_STRUCT;
END_TYPE

TYPE ST_Motor :
STRUCT
    ComandoAutomatico : BOOL;
    ComandoManual : BOOL;
    HabilitaSaidaManual : BOOL;
    ComandoSaida : BOOL;
    RetornoLigado : BOOL;
    EmOperacao : BOOL;
    Falha : BOOL;
    HorimetroSegundos : UDINT;
    NumeroPartidas : UDINT;
END_STRUCT;
END_TYPE

TYPE ST_Valvula :
STRUCT
    ComandoAutomatico : BOOL;
    ComandoManual : BOOL;
    HabilitaSaidaManual : BOOL;
    ComandoSaida : BOOL;
    RetornoAberta : BOOL;
    RetornoFechada : BOOL;
    Aberta : BOOL;
    Fechada : BOOL;
    Falha : BOOL;
END_STRUCT;
END_TYPE

TYPE ST_Comandos :
STRUCT
    IHMLiga : BOOL;
    IHMDesliga : BOOL;
    IHMReset : BOOL;
    IHMAlivioManual : BOOL;
    IHMModoManutencao : BOOL;
    DCSLiga : BOOL;
    DCSDesliga : BOOL;
    DCSReset : BOOL;
END_STRUCT;
END_TYPE

TYPE ST_ComandoConsolidado :
STRUCT
    Liga : BOOL;
    Desliga : BOOL;
    Reset : BOOL;
    Trip : BOOL;
    PermissivosOK : BOOL;
END_STRUCT;
END_TYPE

TYPE ST_StatusMaquina :
STRUCT
    EstadoAtual : INT;
    ProximoEstado : INT;
    EstadoAnterior : INT;
    EstadoOrigemTrip : INT;
    PrimeiroCiclo : BOOL;
    TempoNoEstado : TIME;
    EmOperacao : BOOL;
    EmFalha : BOOL;
    Pronto : BOOL;
END_STRUCT;
END_TYPE
