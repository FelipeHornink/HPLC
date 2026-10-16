(* Process values and operator interface. *)
VAR_GLOBAL
    Level : REAL;              (* LT-100 in engineering units, 0..100 % *)
    Hmi : ST_HmiCommands;
    Status : ST_TankStatus;
END_VAR
