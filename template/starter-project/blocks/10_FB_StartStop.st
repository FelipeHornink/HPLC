(* A reusable start/stop latch. Stop always wins over Start (stop priority), as in a
   classic seal-in circuit. Use one instance per motor. *)
FUNCTION_BLOCK FB_StartStop
VAR_INPUT
    Start : BOOL;
    Stop : BOOL;
END_VAR
VAR_OUTPUT
    Running : BOOL;
END_VAR

IF Stop THEN
    Running := FALSE;
ELSIF Start THEN
    Running := TRUE;
END_IF;
END_FUNCTION_BLOCK
