(* Routine 4 - Auto cycle: Idle (0) -> Filling (1) -> Draining (2) -> Filling ...
   Start (HMI or push button) starts the cycle; Stop, Manual mode or an
   equipment fault returns to Idle. *)
StartEdge(CLK := Hmi.StartCmd OR Inputs.StartButton);
IF Hmi.StopCmd OR NOT Inputs.StopButton OR NOT Status.AutoMode
   OR Status.PumpFault OR Status.ValveFault THEN
    Status.Running := FALSE;
ELSIF StartEdge.Q THEN
    Status.Running := TRUE;
END_IF;

CASE Status.State OF
    0: (* Idle *)
        IF Status.Running THEN
            IF Level < FillTarget THEN
                Status.State := 1;
            ELSE
                Status.State := 2;
            END_IF;
        END_IF;
    1: (* Filling *)
        IF NOT Status.Running THEN
            Status.State := 0;
        ELSIF Level >= FillTarget OR Status.HighAlarm THEN
            Status.State := 2;
        END_IF;
    2: (* Draining *)
        IF NOT Status.Running THEN
            Status.State := 0;
        ELSIF Level <= DrainTarget OR Status.LowAlarm THEN
            Status.State := 1;
        END_IF;
ELSE
    Status.State := 0;
END_CASE;
