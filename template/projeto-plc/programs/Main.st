PROGRAM Main
VAR
    FBPressao : FB_InstrumentoAnalogico;
    FBTemperatura : FB_InstrumentoAnalogico;
    FBMotor : FB_Motor;
    FBExaustor : FB_Motor;
    FBVentilador1 : FB_Motor;
    FBVentilador2 : FB_Motor;
    FBValvula : FB_Valvula;
    TemporizadorEstado : TON;
    PulsoUmSegundo : TON;
    ContadorScan : UINT;
    EstadoAnteriorLocal : INT := -1;
    EstadoLiberado : BOOL;
END_VAR

(* @ROUTINE 01_Espelhamento_Entradas_Analogicas.st *)
(* @ROUTINE 02_Espelhamento_Entradas_Digitais.st *)
(* @ROUTINE 03_Simulacao_Entradas.st *)
(* @ROUTINE 04_Atualizacao_Objetos.st *)
(* @ROUTINE 05_Decisao_Comandos.st *)
(* @ROUTINE 06_Maquina_Estados.st *)
(* @ROUTINE 07_Intertravamento_Atuadores.st *)
(* @ROUTINE 08_Atualizacao_Comandos_Objetos.st *)
(* @ROUTINE 09_Espelhamento_Saidas_Analogicas.st *)
(* @ROUTINE 10_Espelhamento_Saidas_Digitais.st *)
(* @ROUTINE 11_Status_Horimetros.st *)
(* @ROUTINE 12_Reset_Fabrica.st *)
(* @ROUTINE 13_Atualizacao_Valores_Fabrica.st *)
END_PROGRAM
