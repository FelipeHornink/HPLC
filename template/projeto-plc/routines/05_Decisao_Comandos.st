(* Rotina 5 — consolidação das diversas origens de comando. *)
ComandoConsolidado.Liga := InputsDigitais.BotaoLiga OR InputsDigitais.ClienteStart OR Comandos.IHMLiga OR Comandos.DCSLiga;
ComandoConsolidado.Desliga := InputsDigitais.BotaoDesliga OR InputsDigitais.ClienteStop OR Comandos.IHMDesliga OR Comandos.DCSDesliga;
ComandoConsolidado.Reset := InputsDigitais.BotaoReset OR Comandos.IHMReset OR Comandos.DCSReset;
ComandoConsolidado.PermissivosOK := InputsDigitais.EmergenciaSaudavel AND InputsDigitais.PermissivoCliente AND NOT InputsDigitais.ClienteEmergencia AND NOT InputsDigitais.TripExterno AND NOT InputsDigitais.LSH AND NOT TemperaturaOleo.StatusAlarmeHigh;
ComandoConsolidado.Trip := NOT InputsDigitais.EmergenciaSaudavel OR InputsDigitais.ClienteEmergencia OR InputsDigitais.TripExterno OR InputsDigitais.LSH OR TemperaturaOleo.StatusAlarmeHigh;
