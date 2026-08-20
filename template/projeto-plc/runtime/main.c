#include <arpa/inet.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/tcp.h>
#include <limits.h>
#include <time.h>
#include <unistd.h>

#include "iec_std_lib.h"
TIME __CURRENT_TIME;
unsigned long __tick = 0;
#include "POUS.h"
#include "Config0.h"

void config_init__(void);
void config_run__(unsigned long tick);
extern unsigned long long common_ticktime__;
extern MAIN RES0__INST0;

static pthread_mutex_t memory_lock = PTHREAD_MUTEX_INITIALIZER;
static volatile sig_atomic_t keep_running = 1;
static const char *html_path = "panel/index.html";
static const char *panel_config_path = "panel/painel.json";
static const char *pid_html_path = "panel/pid.html";
static const char *pid_config_path = "panel/pid.json";
static const char *panel_dir = "panel";
static const char *pid_path = NULL;
static const char *port_path = NULL;
static const char *pid_port_path = NULL;

typedef enum { DEBUG_RUN, DEBUG_PAUSED, DEBUG_ROUTINE, DEBUG_LINE } debug_mode_t;
#define MAX_DEBUG_TRACE 2048
#define MAX_TRACE_HISTORY 32
static pthread_mutex_t debug_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t debug_condition = PTHREAD_COND_INITIALIZER;
static debug_mode_t debug_mode = DEBUG_RUN;
static unsigned int debug_line_tokens = 0;
static unsigned int debug_routine_tokens = 0;
static unsigned int debug_scan_tokens = 0;
static unsigned int debug_current_line = 0;
static unsigned int debug_current_routine = 0;
static unsigned long debug_step_serial = 0;
static unsigned long debug_routine_serial = 0;
static int debug_waiting_at_line = 0;
static int debug_waiting_at_routine = 0;
static int debug_scan_active = 0;
static unsigned int trace_current[MAX_DEBUG_TRACE], trace_last[MAX_DEBUG_TRACE];
static size_t trace_current_count = 0, trace_last_count = 0;
typedef struct { unsigned long scan; size_t count; unsigned int lines[MAX_DEBUG_TRACE]; } trace_scan_t;
static trace_scan_t trace_history[MAX_TRACE_HISTORY];
static size_t trace_history_next = 0, trace_history_count = 0;

#define MAX_FORCES 128
typedef struct { int active; char path[192]; char value[80]; } force_entry_t;
static force_entry_t forces[MAX_FORCES];
static int set_tag_unlocked(const char *tag, const char *raw);
static TIME milliseconds_to_time(double milliseconds);
static void apply_forces_unlocked(void);
static int is_forced(const char *path);
static const char *debug_mode_name(debug_mode_t mode);

static long long time_ms(TIME value) { return value.tv_sec * 1000LL + value.tv_nsec / 1000000LL; }
static const char *jb(int value) { return value ? "true" : "false"; }
static void stop_runtime(int signal_number) { (void)signal_number; keep_running = 0; }

static int write_metadata(const char *path, long value) {
    if (!path) return 1;
    FILE *file = fopen(path, "w");
    if (!file) return 0;
    fprintf(file, "%ld\n", value);
    fclose(file);
    return 1;
}

static void remove_metadata(void) {
    if (pid_path) unlink(pid_path);
    if (port_path) unlink(port_path);
    if (pid_port_path) unlink(pid_port_path);
}

static void trace_add(unsigned int project_line) {
    if (trace_current_count && trace_current[trace_current_count - 1] == project_line) return;
    if (trace_current_count < MAX_DEBUG_TRACE) trace_current[trace_current_count++] = project_line;
}

/* Chamado pelo C instrumentado imediatamente antes de uma instrução ST. */
void plc_debug_point(unsigned int project_line) {
    pthread_mutex_lock(&debug_lock);
    debug_current_line = project_line;
    apply_forces_unlocked();
    if (debug_mode == DEBUG_LINE) {
        debug_waiting_at_line = 1;
        pthread_mutex_unlock(&memory_lock);
        pthread_cond_broadcast(&debug_condition);
        while (keep_running && debug_mode == DEBUG_LINE && debug_line_tokens == 0)
            pthread_cond_wait(&debug_condition, &debug_lock);
        if (debug_mode == DEBUG_LINE && debug_line_tokens) debug_line_tokens--;
        debug_waiting_at_line = 0;
        pthread_mutex_lock(&memory_lock);
    }
    trace_add(project_line);
    debug_step_serial++;
    pthread_cond_broadcast(&debug_condition);
    pthread_mutex_unlock(&debug_lock);
}

/* Chamado uma vez na entrada de cada arquivo de rotina do ciclo. */
void plc_debug_routine(unsigned int routine_id, unsigned int project_line) {
    pthread_mutex_lock(&debug_lock);
    debug_current_routine = routine_id;
    debug_current_line = project_line;
    debug_routine_serial++;
    if (debug_mode == DEBUG_ROUTINE) {
        debug_waiting_at_routine = 1;
        pthread_mutex_unlock(&memory_lock);
        pthread_cond_broadcast(&debug_condition);
        while (keep_running && debug_mode == DEBUG_ROUTINE && debug_routine_tokens == 0)
            pthread_cond_wait(&debug_condition, &debug_lock);
        if (debug_mode == DEBUG_ROUTINE && debug_routine_tokens) debug_routine_tokens--;
        debug_waiting_at_routine = 0;
        pthread_mutex_lock(&memory_lock);
    }
    pthread_cond_broadcast(&debug_condition);
    pthread_mutex_unlock(&debug_lock);
}

static void *scan_loop(void *unused) {
    (void)unused;
    const long period_ns = (long)common_ticktime__;
    const struct timespec delay = { .tv_sec = 0, .tv_nsec = period_ns };
    while (keep_running) {
        int automatic;
        pthread_mutex_lock(&debug_lock);
        while (keep_running && debug_mode == DEBUG_PAUSED && debug_scan_tokens == 0)
            pthread_cond_wait(&debug_condition, &debug_lock);
        if (!keep_running) { pthread_mutex_unlock(&debug_lock); break; }
        automatic = debug_mode == DEBUG_RUN;
        if (debug_scan_tokens) debug_scan_tokens--;
        debug_scan_active = 1;
        trace_current_count = 0;
        pthread_mutex_unlock(&debug_lock);

        pthread_mutex_lock(&memory_lock);
        apply_forces_unlocked();
        config_run__(__tick++);
        apply_forces_unlocked();
        __CURRENT_TIME.tv_nsec += period_ns;
        while (__CURRENT_TIME.tv_nsec >= 1000000000L) { __CURRENT_TIME.tv_nsec -= 1000000000L; __CURRENT_TIME.tv_sec++; }
        pthread_mutex_unlock(&memory_lock);

        pthread_mutex_lock(&debug_lock);
        memcpy(trace_last, trace_current, trace_current_count * sizeof(trace_current[0]));
        trace_last_count = trace_current_count;
        trace_scan_t *saved = &trace_history[trace_history_next];
        saved->scan = __tick;
        saved->count = trace_current_count;
        memcpy(saved->lines, trace_current, trace_current_count * sizeof(trace_current[0]));
        trace_history_next = (trace_history_next + 1) % MAX_TRACE_HISTORY;
        if (trace_history_count < MAX_TRACE_HISTORY) trace_history_count++;
        debug_scan_active = 0;
        if (debug_mode != DEBUG_LINE && debug_mode != DEBUG_ROUTINE) debug_current_line = 0;
        pthread_cond_broadcast(&debug_condition);
        pthread_mutex_unlock(&debug_lock);
        if (automatic) nanosleep(&delay, NULL);
    }
    return NULL;
}

static const char *debug_mode_name(debug_mode_t mode) {
    return mode == DEBUG_RUN ? "run" : mode == DEBUG_LINE ? "line" : mode == DEBUG_ROUTINE ? "routine" : "paused";
}

static int debug_json(char *b, size_t n) {
    int used = 0;
    pthread_mutex_lock(&debug_lock);
    used += snprintf(b + used, n - (size_t)used,
        "{\"mode\":\"%s\",\"scan\":%lu,\"scan_active\":%s,\"waiting_line\":%s,\"waiting_routine\":%s,\"current_line\":%u,\"current_routine\":%u,\"trace\":[",
        debug_mode_name(debug_mode), __tick, jb(debug_scan_active), jb(debug_waiting_at_line), jb(debug_waiting_at_routine), debug_current_line, debug_current_routine);
    const unsigned int *trace = debug_scan_active ? trace_current : trace_last;
    size_t count = debug_scan_active ? trace_current_count : trace_last_count;
    for (size_t i = 0; i < count && used < (int)n; i++)
        used += snprintf(b + used, n - (size_t)used, "%s%u", i ? "," : "", trace[i]);
    used += snprintf(b + used, n - (size_t)used, "],\"trace_history\":[");
    size_t start = (trace_history_next + MAX_TRACE_HISTORY - trace_history_count) % MAX_TRACE_HISTORY;
    for (size_t h = 0; h < trace_history_count && used < (int)n; h++) {
        trace_scan_t *saved = &trace_history[(start + h) % MAX_TRACE_HISTORY];
        used += snprintf(b + used, n - (size_t)used, "%s{\"scan\":%lu,\"trace\":[", h ? "," : "", saved->scan);
        for (size_t i = 0; i < saved->count && used < (int)n; i++)
            used += snprintf(b + used, n - (size_t)used, "%s%u", i ? "," : "", saved->lines[i]);
        used += snprintf(b + used, n - (size_t)used, "]}");
    }
    used += snprintf(b + used, n - (size_t)used, "]}");
    pthread_mutex_unlock(&debug_lock);
    return used;
}

static void debug_control(const char *action) {
    pthread_mutex_lock(&debug_lock);
    unsigned long old_scan=__tick,old_serial=debug_step_serial,old_routine_serial=debug_routine_serial;
    struct timespec deadline;clock_gettime(CLOCK_REALTIME,&deadline);deadline.tv_nsec+=500000000L;if(deadline.tv_nsec>=1000000000L){deadline.tv_sec++;deadline.tv_nsec-=1000000000L;}
    if (!strcmp(action, "run")) { debug_mode = DEBUG_RUN; debug_line_tokens = debug_routine_tokens = debug_scan_tokens = 0; }
    else if (!strcmp(action, "pause")) { debug_mode = DEBUG_PAUSED; debug_line_tokens = debug_routine_tokens = debug_scan_tokens = 0; }
    else if (!strcmp(action, "scan")) { debug_mode = DEBUG_PAUSED; debug_scan_tokens++; }
    else if (!strcmp(action, "routine")) { debug_mode = DEBUG_ROUTINE; debug_line_tokens = debug_routine_tokens = debug_scan_tokens = 0; }
    else if (!strcmp(action, "next_routine") && debug_mode == DEBUG_ROUTINE) debug_routine_tokens++;
    else if (!strcmp(action, "step_routine")) {
        debug_mode = DEBUG_ROUTINE; debug_line_tokens = debug_scan_tokens = 0; debug_routine_tokens++;
    }
    else if (!strcmp(action, "line")) { debug_mode = DEBUG_LINE; debug_line_tokens = debug_scan_tokens = 0; }
    else if (!strcmp(action, "next") && debug_mode == DEBUG_LINE) debug_line_tokens++;
    else if (!strcmp(action, "step_line")) {
        debug_mode = DEBUG_LINE; debug_routine_tokens = debug_scan_tokens = 0; debug_line_tokens++;
    }
    pthread_cond_broadcast(&debug_condition);
    if(!strcmp(action,"line"))while(keep_running&&debug_mode==DEBUG_LINE&&!debug_waiting_at_line)if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    else if(!strcmp(action,"routine"))while(keep_running&&debug_mode==DEBUG_ROUTINE&&!debug_waiting_at_routine)if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    else if(!strcmp(action,"next_routine"))while(keep_running&&debug_mode==DEBUG_ROUTINE&&(!debug_waiting_at_routine||debug_routine_serial==old_routine_serial))if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    else if(!strcmp(action,"step_routine"))while(keep_running&&debug_mode==DEBUG_ROUTINE&&(!debug_waiting_at_routine||debug_routine_serial==old_routine_serial))if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    else if(!strcmp(action,"next"))while(keep_running&&debug_mode==DEBUG_LINE&&(!debug_waiting_at_line||debug_step_serial==old_serial))if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    else if(!strcmp(action,"step_line"))while(keep_running&&debug_mode==DEBUG_LINE&&(!debug_waiting_at_line||debug_step_serial==old_serial))if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    else if(!strcmp(action,"scan"))while(keep_running&&(__tick==old_scan||debug_scan_active))if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    else if(!strcmp(action,"pause"))while(keep_running&&debug_scan_active)if(pthread_cond_timedwait(&debug_condition,&debug_lock,&deadline))break;
    pthread_mutex_unlock(&debug_lock);
}

static int state_json(char *b, size_t n) {
    ST_ENTRADASDIGITAIS *di = __GET_GLOBAL_INPUTSDIGITAIS();
    ST_SAIDASDIGITAIS *dq = __GET_GLOBAL_OUTPUTSDIGITAIS();
    ST_STATUSMAQUINA *sm = __GET_GLOBAL_STATUSMAQUINA();
    ST_COMANDOS *cm = __GET_GLOBAL_COMANDOS();
    ST_INSTRUMENTOANALOGICO *pr = __GET_GLOBAL_PRESSAOJUSANTE();
    ST_INSTRUMENTOANALOGICO *te = __GET_GLOBAL_TEMPERATURAOLEO();
    ST_INSTRUMENTOANALOGICO *p700=__GET_GLOBAL_PIT700(),*p701=__GET_GLOBAL_PIT701(),*p702=__GET_GLOBAL_PIT702(),*p703=__GET_GLOBAL_PIT703(),*p704=__GET_GLOBAL_PIT704(),*p705=__GET_GLOBAL_PIT705();
    ST_INSTRUMENTOANALOGICO *t700=__GET_GLOBAL_TIT700(),*t701=__GET_GLOBAL_TIT701(),*t702=__GET_GLOBAL_TIT702(),*t703=__GET_GLOBAL_TIT703(),*t704=__GET_GLOBAL_TIT704();
    int length;
    pthread_mutex_lock(&memory_lock);
    length = snprintf(b, n,
      "{\"running\":true,\"mode\":\"%s\",\"scan_active\":%s,\"scan\":%lu,\"scan_ms\":10,\"estado\":%d,\"tempo_estado_ms\":%lld,"
      "\"pressao\":%.3f,\"temperatura\":%.2f,\"simulacao\":%s,"
      "\"di\":{\"liga\":%s,\"desliga\":%s,\"reset\":%s,\"emergencia\":%s,\"permissivo\":%s,\"local_remoto\":%s,\"cliente_start\":%s,\"cliente_stop\":%s,\"cliente_emergencia\":%s,\"trip_externo\":%s,\"lsh\":%s},"
      "\"cmd\":{\"ihm_liga\":%s,\"ihm_desliga\":%s,\"ihm_reset\":%s,\"alivio_manual\":%s,\"manutencao\":%s},"
      "\"dq\":{\"auxiliares\":%s,\"motor\":%s,\"exaustor\":%s,\"ventilador1\":%s,\"ventilador2\":%s,\"aquecimento\":%s,\"valvula\":%s,\"pronto\":%s,\"ligado\":%s,\"falha\":%s,\"cliente_alarme\":%s,\"cliente_trip\":%s,\"cliente_remoto\":%s,\"cliente_permissivo\":%s,\"cliente_fonte\":%s},"
      "\"instrumentos\":{\"PIT700\":%.3f,\"PIT701\":%.3f,\"PIT702\":%.3f,\"PIT703\":%.3f,\"PIT704\":%.3f,\"PIT705\":%.3f,\"TIT700\":%.2f,\"TIT701\":%.2f,\"TIT702\":%.2f,\"TIT703\":%.2f,\"TIT704\":%.2f},"
      "\"total_partidas\":%u,\"total_trips\":%u}",
      debug_mode_name(debug_mode), jb(debug_scan_active), __tick, sm->ESTADOATUAL, time_ms(sm->TEMPONOESTADO), pr->VALORENGENHARIA, te->VALORENGENHARIA,
      jb(*__GET_GLOBAL_HABILITASIMULACAO()), jb(di->BOTAOLIGA), jb(di->BOTAODESLIGA), jb(di->BOTAORESET),
      jb(di->EMERGENCIASAUDAVEL), jb(di->PERMISSIVOCLIENTE), jb(di->SELETORLOCALREMOTO), jb(di->CLIENTESTART), jb(di->CLIENTESTOP), jb(di->CLIENTEEMERGENCIA), jb(di->TRIPEXTERNO), jb(di->LSH),
      jb(cm->IHMLIGA), jb(cm->IHMDESLIGA), jb(cm->IHMRESET), jb(cm->IHMALIVIOMANUAL), jb(cm->IHMMODOMANUTENCAO),
      jb(dq->LIGAAUXILIARES), jb(dq->LIGAMOTORPRINCIPAL), jb(dq->LIGAEXAUSTOR), jb(dq->LIGAVENTILADOR1), jb(dq->LIGAVENTILADOR2), jb(dq->LIGARESISTENCIAAQUECIMENTO), jb(dq->ABREVALVULASUCAO), jb(dq->SINALEIROPRONTO),
      jb(dq->SINALEIROLIGADO), jb(dq->SINALEIROFALHA), jb(dq->CLIENTERESUMOALARME), jb(dq->CLIENTERESUMOTRIP), jb(dq->CLIENTEMODOREMOTO), jb(dq->CLIENTEPERMISSIVOPARTIDA), jb(dq->CLIENTEFALHAFONTE),
      p700->VALORENGENHARIA,p701->VALORENGENHARIA,p702->VALORENGENHARIA,p703->VALORENGENHARIA,p704->VALORENGENHARIA,p705->VALORENGENHARIA,t700->VALORENGENHARIA,t701->VALORENGENHARIA,t702->VALORENGENHARIA,t703->VALORENGENHARIA,t704->VALORENGENHARIA,
      *__GET_GLOBAL_TOTALPARTIDAS(), *__GET_GLOBAL_TOTALTRIPS());
    pthread_mutex_unlock(&memory_lock);
    return length;
}

static void add_var(char *b, size_t n, int *used, int *first, const char *path, const char *type, const char *value, int writable) {
    if (*used >= (int)n) return;
    (void)writable;
    *used += snprintf(b + *used, n - (size_t)*used, "%s{\"path\":\"%s\",\"type\":\"%s\",\"value\":%s,\"writable\":true,\"forced\":%s}",
        *first ? "" : ",", path, type, value, is_forced(path) ? "true" : "false");
    *first = 0;
}
static void add_bool(char *b,size_t n,int*u,int*f,const char*p,int v,int w){add_var(b,n,u,f,p,"BOOL",v?"true":"false",w);}
static void add_int(char *b,size_t n,int*u,int*f,const char*p,long long v,int w){char x[48];snprintf(x,sizeof x,"%lld",v);add_var(b,n,u,f,p,"INT",x,w);}
static void add_real(char *b,size_t n,int*u,int*f,const char*p,double v,int w){char x[64];snprintf(x,sizeof x,"%.4f",v);add_var(b,n,u,f,p,"REAL",x,w);}
static void add_integer(char *b,size_t n,int*u,int*f,const char*p,const char*t,long long v,int w){char x[48];snprintf(x,sizeof x,"%lld",v);add_var(b,n,u,f,p,t,x,w);}
static void add_float(char *b,size_t n,int*u,int*f,const char*p,const char*t,double v,int w){char x[64];snprintf(x,sizeof x,"%.6g",v);add_var(b,n,u,f,p,t,x,w);}
static void add_time(char *b,size_t n,int*u,int*f,const char*p,TIME v){char x[64];snprintf(x,sizeof x,"%lld",time_ms(v));add_var(b,n,u,f,p,"TIME_MS",x,0);}

#include "variables_generated.inc"

static int variables_json_legacy(char *b, size_t n) {
    ST_ENTRADASDIGITAIS *di = __GET_GLOBAL_INPUTSDIGITAIS(); ST_ENTRADASANALOGICAS *ai = __GET_GLOBAL_INPUTSANALOGICOS();
    ST_SAIDASDIGITAIS *dq = __GET_GLOBAL_OUTPUTSDIGITAIS(); ST_INSTRUMENTOANALOGICO *pr = __GET_GLOBAL_PRESSAOJUSANTE();
    ST_INSTRUMENTOANALOGICO *te = __GET_GLOBAL_TEMPERATURAOLEO(); ST_MOTOR *mo = __GET_GLOBAL_MOTORPRINCIPAL();
    ST_VALVULA *va = __GET_GLOBAL_VALVULASUCAO(); ST_COMANDOS *cm = __GET_GLOBAL_COMANDOS();
    ST_COMANDOCONSOLIDADO *cc = __GET_GLOBAL_COMANDOCONSOLIDADO(); ST_STATUSMAQUINA *sm = __GET_GLOBAL_STATUSMAQUINA();
    ST_MOTOR *ex=__GET_GLOBAL_MOTOREXAUSTOR(),*v1=__GET_GLOBAL_MOTORVENTILADOR1(),*v2=__GET_GLOBAL_MOTORVENTILADOR2();
    ST_INSTRUMENTOANALOGICO *instruments[]={__GET_GLOBAL_PIT700(),__GET_GLOBAL_PIT701(),__GET_GLOBAL_PIT702(),__GET_GLOBAL_PIT703(),__GET_GLOBAL_PIT704(),__GET_GLOBAL_PIT705(),__GET_GLOBAL_TIT700(),__GET_GLOBAL_TIT701(),__GET_GLOBAL_TIT702(),__GET_GLOBAL_TIT703(),__GET_GLOBAL_TIT704()};
    const char *instrument_names[]={"PIT700","PIT701","PIT702","PIT703","PIT704","PIT705","TIT700","TIT701","TIT702","TIT703","TIT704"};
    int u=0,f=1; pthread_mutex_lock(&memory_lock); u+=snprintf(b,n,"{\"scan\":%lu,\"variables\":[",__tick);
    add_bool(b,n,&u,&f,"InputsDigitais.BotaoLiga",di->BOTAOLIGA,1); add_bool(b,n,&u,&f,"InputsDigitais.BotaoDesliga",di->BOTAODESLIGA,1);
    add_bool(b,n,&u,&f,"InputsDigitais.BotaoReset",di->BOTAORESET,1); add_bool(b,n,&u,&f,"InputsDigitais.EmergenciaSaudavel",di->EMERGENCIASAUDAVEL,1);
    add_bool(b,n,&u,&f,"InputsDigitais.PermissivoCliente",di->PERMISSIVOCLIENTE,1); add_bool(b,n,&u,&f,"InputsDigitais.RetornoMotor",di->RETORNOMOTOR,0);
    add_bool(b,n,&u,&f,"InputsDigitais.SeletorLocalRemoto",di->SELETORLOCALREMOTO,1); add_bool(b,n,&u,&f,"InputsDigitais.ClienteStart",di->CLIENTESTART,1);
    add_bool(b,n,&u,&f,"InputsDigitais.ClienteStop",di->CLIENTESTOP,1); add_bool(b,n,&u,&f,"InputsDigitais.ClienteEmergencia",di->CLIENTEEMERGENCIA,1);
    add_bool(b,n,&u,&f,"InputsDigitais.TripExterno",di->TRIPEXTERNO,1); add_bool(b,n,&u,&f,"InputsDigitais.LSH",di->LSH,1);
    add_bool(b,n,&u,&f,"InputsDigitais.RetornoExaustor",di->RETORNOEXAUSTOR,0); add_bool(b,n,&u,&f,"InputsDigitais.RetornoVentilador1",di->RETORNOVENTILADOR1,0); add_bool(b,n,&u,&f,"InputsDigitais.RetornoVentilador2",di->RETORNOVENTILADOR2,0);
    add_bool(b,n,&u,&f,"InputsDigitais.RetornoValvulaAberta",di->RETORNOVALVULAABERTA,0); add_bool(b,n,&u,&f,"InputsDigitais.RetornoValvulaFechada",di->RETORNOVALVULAFECHADA,0);
    add_int(b,n,&u,&f,"InputsAnalogicos.PressaoJusanteRaw",ai->PRESSAOJUSANTERAW,1); add_int(b,n,&u,&f,"InputsAnalogicos.TemperaturaOleoRaw",ai->TEMPERATURAOLEORAW,1);
    add_bool(b,n,&u,&f,"OutputsDigitais.LigaAuxiliares",dq->LIGAAUXILIARES,0); add_bool(b,n,&u,&f,"OutputsDigitais.LigaMotorPrincipal",dq->LIGAMOTORPRINCIPAL,0);
    add_bool(b,n,&u,&f,"OutputsDigitais.AbreValvulaSucao",dq->ABREVALVULASUCAO,0); add_bool(b,n,&u,&f,"HabilitaSimulacao",*__GET_GLOBAL_HABILITASIMULACAO(),1);
    add_bool(b,n,&u,&f,"OutputsDigitais.SinaleiroPronto",dq->SINALEIROPRONTO,0); add_bool(b,n,&u,&f,"OutputsDigitais.SinaleiroLigado",dq->SINALEIROLIGADO,0); add_bool(b,n,&u,&f,"OutputsDigitais.SinaleiroFalha",dq->SINALEIROFALHA,0);
    add_bool(b,n,&u,&f,"OutputsDigitais.LigaExaustor",dq->LIGAEXAUSTOR,0); add_bool(b,n,&u,&f,"OutputsDigitais.LigaVentilador1",dq->LIGAVENTILADOR1,0); add_bool(b,n,&u,&f,"OutputsDigitais.LigaVentilador2",dq->LIGAVENTILADOR2,0); add_bool(b,n,&u,&f,"OutputsDigitais.LigaResistenciaAquecimento",dq->LIGARESISTENCIAAQUECIMENTO,0);
    add_bool(b,n,&u,&f,"INTERFACE.Cliente.ResumoAlarme",dq->CLIENTERESUMOALARME,0); add_bool(b,n,&u,&f,"INTERFACE.Cliente.ResumoTrip",dq->CLIENTERESUMOTRIP,0); add_bool(b,n,&u,&f,"INTERFACE.Cliente.ModoRemoto",dq->CLIENTEMODOREMOTO,0); add_bool(b,n,&u,&f,"INTERFACE.Cliente.PermissivoPartida",dq->CLIENTEPERMISSIVOPARTIDA,0); add_bool(b,n,&u,&f,"INTERFACE.Cliente.FalhaFonte",dq->CLIENTEFALHAFONTE,0);
    add_real(b,n,&u,&f,"PressaoJusante.ValorEngenharia",pr->VALORENGENHARIA,0); add_real(b,n,&u,&f,"PressaoJusante.ValorSimulado",pr->VALORSIMULADO,1);
    add_bool(b,n,&u,&f,"PressaoJusante.StatusAlarmeHigh",pr->STATUSALARMEHIGH,0); add_bool(b,n,&u,&f,"PressaoJusante.Desconectado",pr->DESCONECTADO,0);
    add_real(b,n,&u,&f,"TemperaturaOleo.ValorEngenharia",te->VALORENGENHARIA,0); add_real(b,n,&u,&f,"TemperaturaOleo.ValorSimulado",te->VALORSIMULADO,1);
    add_bool(b,n,&u,&f,"TemperaturaOleo.StatusAlarmeHigh",te->STATUSALARMEHIGH,0); add_bool(b,n,&u,&f,"MotorPrincipal.ComandoAutomatico",mo->COMANDOAUTOMATICO,0);
    add_bool(b,n,&u,&f,"MotorPrincipal.ComandoManual",mo->COMANDOMANUAL,1); add_bool(b,n,&u,&f,"MotorPrincipal.HabilitaSaidaManual",mo->HABILITASAIDAMANUAL,1);
    add_bool(b,n,&u,&f,"MotorPrincipal.ComandoSaida",mo->COMANDOSAIDA,0); add_bool(b,n,&u,&f,"MotorPrincipal.EmOperacao",mo->EMOPERACAO,0); add_bool(b,n,&u,&f,"MotorPrincipal.Falha",mo->FALHA,0);
    add_bool(b,n,&u,&f,"MotorExaustor.ComandoSaida",ex->COMANDOSAIDA,0); add_bool(b,n,&u,&f,"MotorExaustor.EmOperacao",ex->EMOPERACAO,0); add_bool(b,n,&u,&f,"MotorVentilador1.ComandoSaida",v1->COMANDOSAIDA,0); add_bool(b,n,&u,&f,"MotorVentilador1.EmOperacao",v1->EMOPERACAO,0); add_bool(b,n,&u,&f,"MotorVentilador2.ComandoSaida",v2->COMANDOSAIDA,0); add_bool(b,n,&u,&f,"MotorVentilador2.EmOperacao",v2->EMOPERACAO,0);
    for(int i=0;i<11;i++){char path[96];snprintf(path,sizeof path,"PROCESSO.Instrumentos.%s.ValorEngenharia",instrument_names[i]);add_real(b,n,&u,&f,path,instruments[i]->VALORENGENHARIA,0);}
    add_bool(b,n,&u,&f,"ValvulaSucao.ComandoAutomatico",va->COMANDOAUTOMATICO,0); add_bool(b,n,&u,&f,"ValvulaSucao.ComandoManual",va->COMANDOMANUAL,1);
    add_bool(b,n,&u,&f,"ValvulaSucao.HabilitaSaidaManual",va->HABILITASAIDAMANUAL,1); add_bool(b,n,&u,&f,"ValvulaSucao.ComandoSaida",va->COMANDOSAIDA,0);
    add_bool(b,n,&u,&f,"Comandos.IHMLiga",cm->IHMLIGA,1); add_bool(b,n,&u,&f,"Comandos.IHMDesliga",cm->IHMDESLIGA,1); add_bool(b,n,&u,&f,"Comandos.IHMReset",cm->IHMRESET,1);
    add_bool(b,n,&u,&f,"Comandos.IHMAlivioManual",cm->IHMALIVIOMANUAL,1); add_bool(b,n,&u,&f,"Comandos.IHMModoManutencao",cm->IHMMODOMANUTENCAO,1);
    add_bool(b,n,&u,&f,"ComandoConsolidado.Liga",cc->LIGA,0); add_bool(b,n,&u,&f,"ComandoConsolidado.Desliga",cc->DESLIGA,0); add_bool(b,n,&u,&f,"ComandoConsolidado.Reset",cc->RESET,0);
    add_bool(b,n,&u,&f,"ComandoConsolidado.Trip",cc->TRIP,0); add_bool(b,n,&u,&f,"ComandoConsolidado.PermissivosOK",cc->PERMISSIVOSOK,0);
    add_int(b,n,&u,&f,"StatusMaquina.EstadoAtual",sm->ESTADOATUAL,0); add_int(b,n,&u,&f,"StatusMaquina.EstadoAnterior",sm->ESTADOANTERIOR,0);
    add_int(b,n,&u,&f,"StatusMaquina.EstadoOrigemTrip",sm->ESTADOORIGEMTRIP,0); add_time(b,n,&u,&f,"StatusMaquina.TempoNoEstado",sm->TEMPONOESTADO);
    add_bool(b,n,&u,&f,"StatusMaquina.PrimeiroCiclo",sm->PRIMEIROCICLO,0); add_bool(b,n,&u,&f,"StatusMaquina.EmOperacao",sm->EMOPERACAO,0); add_bool(b,n,&u,&f,"StatusMaquina.EmFalha",sm->EMFALHA,0);
    add_real(b,n,&u,&f,"SetpointCarga",*__GET_GLOBAL_SETPOINTCARGA(),1); add_real(b,n,&u,&f,"SetpointAlivio",*__GET_GLOBAL_SETPOINTALIVIO(),1);
    add_bool(b,n,&u,&f,"Main.FBMotor.ComandoSaida",__GET_VAR(RES0__INST0.FBMOTOR.COMANDOSAIDA,),0); add_bool(b,n,&u,&f,"Main.FBMotor.PermiteOperacao",__GET_VAR(RES0__INST0.FBMOTOR.PERMITEOPERACAO,),0);
    add_bool(b,n,&u,&f,"Main.FBValvula.ComandoSaida",__GET_VAR(RES0__INST0.FBVALVULA.COMANDOSAIDA,),0); add_time(b,n,&u,&f,"Main.TemporizadorEstado.ET",__GET_VAR(RES0__INST0.TEMPORIZADORESTADO.ET,));
    add_bool(b,n,&u,&f,"IHMPronto",*__GET_GLOBAL_IHMPRONTO(),0); add_bool(b,n,&u,&f,"IHMEmOperacao",*__GET_GLOBAL_IHMEMOPERACAO(),0); add_bool(b,n,&u,&f,"IHMEmFalha",*__GET_GLOBAL_IHMEMFALHA(),0);
    add_int(b,n,&u,&f,"TotalPartidas",*__GET_GLOBAL_TOTALPARTIDAS(),0); add_int(b,n,&u,&f,"TotalTrips",*__GET_GLOBAL_TOTALTRIPS(),0);
    u+=snprintf(b+u,n-(size_t)u,"]}"); pthread_mutex_unlock(&memory_lock); return u;
}

static int variables_json(char *b, size_t n) {
    int used=0, first=1;
    pthread_mutex_lock(&memory_lock);
    used+=snprintf(b,n,"{\"scan\":%lu,\"variables\":[",__tick);
    generated_add_variables(b,n,&used,&first);
    used+=snprintf(b+used,n-(size_t)used,"]}");
    pthread_mutex_unlock(&memory_lock);
    return used;
}

static TIME milliseconds_to_time(double milliseconds) {
    TIME value; long long total_nanoseconds=(long long)(milliseconds*1000000.0);
    value.tv_sec=(long)(total_nanoseconds/1000000000LL);value.tv_nsec=(long)(total_nanoseconds%1000000000LL);return value;
}

static int set_tag_unlocked_legacy(const char *tag, const char *raw) {
    int bv = (!strcmp(raw,"true") || atoi(raw)!=0); double rv = atof(raw); int ok=1;
    ST_ENTRADASDIGITAIS *di=__GET_GLOBAL_INPUTSDIGITAIS(); ST_ENTRADASANALOGICAS *ai=__GET_GLOBAL_INPUTSANALOGICOS();
    ST_SAIDASDIGITAIS *dq=__GET_GLOBAL_OUTPUTSDIGITAIS(); ST_COMANDOS *cm=__GET_GLOBAL_COMANDOS();
    ST_COMANDOCONSOLIDADO *cc=__GET_GLOBAL_COMANDOCONSOLIDADO(); ST_STATUSMAQUINA *sm=__GET_GLOBAL_STATUSMAQUINA();
    ST_INSTRUMENTOANALOGICO *pr=__GET_GLOBAL_PRESSAOJUSANTE(),*te=__GET_GLOBAL_TEMPERATURAOLEO();
    ST_MOTOR *mo=__GET_GLOBAL_MOTORPRINCIPAL(); ST_VALVULA *va=__GET_GLOBAL_VALVULASUCAO();
    ST_MOTOR *ex=__GET_GLOBAL_MOTOREXAUSTOR(),*v1=__GET_GLOBAL_MOTORVENTILADOR1(),*v2=__GET_GLOBAL_MOTORVENTILADOR2();
    if (!strcmp(tag,"liga")||!strcmp(tag,"InputsDigitais.BotaoLiga")) di->BOTAOLIGA=bv;
    else if (!strcmp(tag,"desliga")||!strcmp(tag,"InputsDigitais.BotaoDesliga")) di->BOTAODESLIGA=bv;
    else if (!strcmp(tag,"reset")||!strcmp(tag,"InputsDigitais.BotaoReset")) di->BOTAORESET=bv;
    else if (!strcmp(tag,"emergencia")||!strcmp(tag,"InputsDigitais.EmergenciaSaudavel")) di->EMERGENCIASAUDAVEL=bv;
    else if (!strcmp(tag,"permissivo")||!strcmp(tag,"InputsDigitais.PermissivoCliente")) di->PERMISSIVOCLIENTE=bv;
    else if (!strcmp(tag,"InputsDigitais.SeletorLocalRemoto")) di->SELETORLOCALREMOTO=bv;
    else if (!strcmp(tag,"InputsDigitais.ClienteStart")) di->CLIENTESTART=bv;
    else if (!strcmp(tag,"InputsDigitais.ClienteStop")) di->CLIENTESTOP=bv;
    else if (!strcmp(tag,"InputsDigitais.ClienteEmergencia")) di->CLIENTEEMERGENCIA=bv;
    else if (!strcmp(tag,"InputsDigitais.TripExterno")) di->TRIPEXTERNO=bv;
    else if (!strcmp(tag,"InputsDigitais.LSH")) di->LSH=bv;
    else if (!strcmp(tag,"InputsDigitais.RetornoExaustor")) di->RETORNOEXAUSTOR=bv;
    else if (!strcmp(tag,"InputsDigitais.RetornoVentilador1")) di->RETORNOVENTILADOR1=bv;
    else if (!strcmp(tag,"InputsDigitais.RetornoVentilador2")) di->RETORNOVENTILADOR2=bv;
    else if (!strcmp(tag,"InputsDigitais.RetornoMotor")) di->RETORNOMOTOR=bv;
    else if (!strcmp(tag,"InputsDigitais.RetornoValvulaAberta")) di->RETORNOVALVULAABERTA=bv;
    else if (!strcmp(tag,"InputsDigitais.RetornoValvulaFechada")) di->RETORNOVALVULAFECHADA=bv;
    else if (!strcmp(tag,"InputsAnalogicos.PressaoJusanteRaw")) ai->PRESSAOJUSANTERAW=(INT)rv;
    else if (!strcmp(tag,"InputsAnalogicos.TemperaturaOleoRaw")) ai->TEMPERATURAOLEORAW=(INT)rv;
    else if (!strcmp(tag,"OutputsDigitais.LigaAuxiliares")) dq->LIGAAUXILIARES=bv;
    else if (!strcmp(tag,"OutputsDigitais.LigaMotorPrincipal")) dq->LIGAMOTORPRINCIPAL=bv;
    else if (!strcmp(tag,"OutputsDigitais.AbreValvulaSucao")) dq->ABREVALVULASUCAO=bv;
    else if (!strcmp(tag,"OutputsDigitais.SinaleiroPronto")) dq->SINALEIROPRONTO=bv;
    else if (!strcmp(tag,"OutputsDigitais.SinaleiroLigado")) dq->SINALEIROLIGADO=bv;
    else if (!strcmp(tag,"OutputsDigitais.SinaleiroFalha")) dq->SINALEIROFALHA=bv;
    else if (!strcmp(tag,"OutputsDigitais.LigaExaustor")) dq->LIGAEXAUSTOR=bv;
    else if (!strcmp(tag,"OutputsDigitais.LigaVentilador1")) dq->LIGAVENTILADOR1=bv;
    else if (!strcmp(tag,"OutputsDigitais.LigaVentilador2")) dq->LIGAVENTILADOR2=bv;
    else if (!strcmp(tag,"OutputsDigitais.LigaResistenciaAquecimento")) dq->LIGARESISTENCIAAQUECIMENTO=bv;
    else if (!strcmp(tag,"INTERFACE.Cliente.ResumoAlarme")) dq->CLIENTERESUMOALARME=bv;
    else if (!strcmp(tag,"INTERFACE.Cliente.ResumoTrip")) dq->CLIENTERESUMOTRIP=bv;
    else if (!strcmp(tag,"INTERFACE.Cliente.ModoRemoto")) dq->CLIENTEMODOREMOTO=bv;
    else if (!strcmp(tag,"INTERFACE.Cliente.PermissivoPartida")) dq->CLIENTEPERMISSIVOPARTIDA=bv;
    else if (!strcmp(tag,"INTERFACE.Cliente.FalhaFonte")) dq->CLIENTEFALHAFONTE=bv;
    else if (!strcmp(tag,"alivio_manual")||!strcmp(tag,"Comandos.IHMAlivioManual")) cm->IHMALIVIOMANUAL=bv;
    else if (!strcmp(tag,"manutencao")||!strcmp(tag,"Comandos.IHMModoManutencao")) cm->IHMMODOMANUTENCAO=bv;
    else if (!strcmp(tag,"Comandos.IHMLiga")) cm->IHMLIGA=bv;
    else if (!strcmp(tag,"Comandos.IHMDesliga")) cm->IHMDESLIGA=bv;
    else if (!strcmp(tag,"Comandos.IHMReset")) cm->IHMRESET=bv;
    else if (!strcmp(tag,"HabilitaSimulacao")) *__GET_GLOBAL_HABILITASIMULACAO()=bv;
    else if (!strcmp(tag,"PressaoJusante.ValorEngenharia")) pr->VALORENGENHARIA=(REAL)rv;
    else if (!strcmp(tag,"PressaoJusante.ValorSimulado")) pr->VALORSIMULADO=(REAL)rv;
    else if (!strcmp(tag,"PressaoJusante.StatusAlarmeHigh")) pr->STATUSALARMEHIGH=bv;
    else if (!strcmp(tag,"PressaoJusante.Desconectado")) pr->DESCONECTADO=bv;
    else if (!strcmp(tag,"TemperaturaOleo.ValorEngenharia")) te->VALORENGENHARIA=(REAL)rv;
    else if (!strcmp(tag,"TemperaturaOleo.ValorSimulado")) te->VALORSIMULADO=(REAL)rv;
    else if (!strcmp(tag,"TemperaturaOleo.StatusAlarmeHigh")) te->STATUSALARMEHIGH=bv;
    else if (!strcmp(tag,"MotorPrincipal.ComandoAutomatico")) mo->COMANDOAUTOMATICO=bv;
    else if (!strcmp(tag,"MotorPrincipal.ComandoManual")) mo->COMANDOMANUAL=bv;
    else if (!strcmp(tag,"MotorPrincipal.HabilitaSaidaManual")) mo->HABILITASAIDAMANUAL=bv;
    else if (!strcmp(tag,"MotorPrincipal.ComandoSaida")) mo->COMANDOSAIDA=bv;
    else if (!strcmp(tag,"MotorPrincipal.EmOperacao")) mo->EMOPERACAO=bv;
    else if (!strcmp(tag,"MotorPrincipal.Falha")) mo->FALHA=bv;
    else if (!strcmp(tag,"MotorExaustor.ComandoSaida")) ex->COMANDOSAIDA=bv;
    else if (!strcmp(tag,"MotorExaustor.EmOperacao")) ex->EMOPERACAO=bv;
    else if (!strcmp(tag,"MotorVentilador1.ComandoSaida")) v1->COMANDOSAIDA=bv;
    else if (!strcmp(tag,"MotorVentilador1.EmOperacao")) v1->EMOPERACAO=bv;
    else if (!strcmp(tag,"MotorVentilador2.ComandoSaida")) v2->COMANDOSAIDA=bv;
    else if (!strcmp(tag,"MotorVentilador2.EmOperacao")) v2->EMOPERACAO=bv;
    else if (!strcmp(tag,"ValvulaSucao.ComandoAutomatico")) va->COMANDOAUTOMATICO=bv;
    else if (!strcmp(tag,"ValvulaSucao.ComandoManual")) va->COMANDOMANUAL=bv;
    else if (!strcmp(tag,"ValvulaSucao.HabilitaSaidaManual")) va->HABILITASAIDAMANUAL=bv;
    else if (!strcmp(tag,"ValvulaSucao.ComandoSaida")) va->COMANDOSAIDA=bv;
    else if (!strcmp(tag,"ComandoConsolidado.Liga")) cc->LIGA=bv;
    else if (!strcmp(tag,"ComandoConsolidado.Desliga")) cc->DESLIGA=bv;
    else if (!strcmp(tag,"ComandoConsolidado.Reset")) cc->RESET=bv;
    else if (!strcmp(tag,"ComandoConsolidado.Trip")) cc->TRIP=bv;
    else if (!strcmp(tag,"ComandoConsolidado.PermissivosOK")) cc->PERMISSIVOSOK=bv;
    else if (!strcmp(tag,"StatusMaquina.EstadoAtual")) sm->ESTADOATUAL=(INT)rv;
    else if (!strcmp(tag,"StatusMaquina.EstadoAnterior")) sm->ESTADOANTERIOR=(INT)rv;
    else if (!strcmp(tag,"StatusMaquina.EstadoOrigemTrip")) sm->ESTADOORIGEMTRIP=(INT)rv;
    else if (!strcmp(tag,"StatusMaquina.TempoNoEstado")) sm->TEMPONOESTADO=milliseconds_to_time(rv);
    else if (!strcmp(tag,"StatusMaquina.PrimeiroCiclo")) sm->PRIMEIROCICLO=bv;
    else if (!strcmp(tag,"StatusMaquina.EmOperacao")) sm->EMOPERACAO=bv;
    else if (!strcmp(tag,"StatusMaquina.EmFalha")) sm->EMFALHA=bv;
    else if (!strcmp(tag,"SetpointCarga")) *__GET_GLOBAL_SETPOINTCARGA()=(REAL)rv;
    else if (!strcmp(tag,"SetpointAlivio")) *__GET_GLOBAL_SETPOINTALIVIO()=(REAL)rv;
    else if (!strcmp(tag,"Main.FBMotor.ComandoSaida")) RES0__INST0.FBMOTOR.COMANDOSAIDA.value=bv;
    else if (!strcmp(tag,"Main.FBMotor.PermiteOperacao")) RES0__INST0.FBMOTOR.PERMITEOPERACAO.value=bv;
    else if (!strcmp(tag,"Main.FBValvula.ComandoSaida")) RES0__INST0.FBVALVULA.COMANDOSAIDA.value=bv;
    else if (!strcmp(tag,"Main.TemporizadorEstado.ET")) RES0__INST0.TEMPORIZADORESTADO.ET.value=milliseconds_to_time(rv);
    else if (!strcmp(tag,"IHMPronto")) *__GET_GLOBAL_IHMPRONTO()=bv;
    else if (!strcmp(tag,"IHMEmOperacao")) *__GET_GLOBAL_IHMEMOPERACAO()=bv;
    else if (!strcmp(tag,"IHMEmFalha")) *__GET_GLOBAL_IHMEMFALHA()=bv;
    else if (!strcmp(tag,"TotalPartidas")) *__GET_GLOBAL_TOTALPARTIDAS()=(UDINT)strtoul(raw,NULL,10);
    else if (!strcmp(tag,"TotalTrips")) *__GET_GLOBAL_TOTALTRIPS()=(UDINT)strtoul(raw,NULL,10);
    else {
        ST_INSTRUMENTOANALOGICO *items[]={__GET_GLOBAL_PIT700(),__GET_GLOBAL_PIT701(),__GET_GLOBAL_PIT702(),__GET_GLOBAL_PIT703(),__GET_GLOBAL_PIT704(),__GET_GLOBAL_PIT705(),__GET_GLOBAL_TIT700(),__GET_GLOBAL_TIT701(),__GET_GLOBAL_TIT702(),__GET_GLOBAL_TIT703(),__GET_GLOBAL_TIT704()};
        const char *names[]={"PIT700","PIT701","PIT702","PIT703","PIT704","PIT705","TIT700","TIT701","TIT702","TIT703","TIT704"};
        ok=0;
        for(int i=0;i<11;i++){char path[96];snprintf(path,sizeof path,"PROCESSO.Instrumentos.%s.ValorEngenharia",names[i]);if(!strcmp(tag,path)){items[i]->VALORENGENHARIA=(REAL)rv;ok=1;break;}}
    }
    return ok;
}

static int set_tag_unlocked(const char *tag, const char *raw) {
    return generated_set_tag(tag, raw);
}

static int set_tag(const char *tag, const char *raw) {
    pthread_mutex_lock(&memory_lock);int ok=set_tag_unlocked(tag,raw);pthread_mutex_unlock(&memory_lock);return ok;
}

static int is_forced(const char *path) {
    for(int i=0;i<MAX_FORCES;i++)if(forces[i].active&&!strcmp(forces[i].path,path))return 1;return 0;
}

static void apply_forces_unlocked(void) {
    for(int i=0;i<MAX_FORCES;i++)if(forces[i].active)set_tag_unlocked(forces[i].path,forces[i].value);
}

static int set_force(const char *path,const char *value,int enabled) {
    pthread_mutex_lock(&memory_lock);int slot=-1;
    for(int i=0;i<MAX_FORCES;i++){if(forces[i].active&&!strcmp(forces[i].path,path)){slot=i;break;}if(slot<0&&!forces[i].active)slot=i;}
    if(slot<0){pthread_mutex_unlock(&memory_lock);return 0;}
    if(!enabled){forces[slot].active=0;pthread_mutex_unlock(&memory_lock);return 1;}
    if(!set_tag_unlocked(path,value)){pthread_mutex_unlock(&memory_lock);return 0;}
    forces[slot].active=1;snprintf(forces[slot].path,sizeof forces[slot].path,"%s",path);snprintf(forces[slot].value,sizeof forces[slot].value,"%s",value);
    pthread_mutex_unlock(&memory_lock);return 1;
}

static int send_all(int c,const char*d,size_t n){size_t s=0;while(s<n){ssize_t w=send(c,d+s,n-s,MSG_NOSIGNAL);if(w<=0)return 0;s+=(size_t)w;}return 1;}
static void respond(int c,const char*t,const char*b,size_t n){char h[512];int z=snprintf(h,sizeof h,"HTTP/1.1 200 OK\r\nContent-Type: %s\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %zu\r\nConnection: keep-alive\r\nKeep-Alive: timeout=60, max=1000\r\n\r\n",t,n);send_all(c,h,(size_t)z);send_all(c,b,n);}
static int respond_file(int c,const char *path,const char *content_type){FILE*f=fopen(path,"rb");if(!f)return 0;fseek(f,0,SEEK_END);long z=ftell(f);rewind(f);char*b=malloc((size_t)z);size_t rd=fread(b,1,(size_t)z,f);fclose(f);respond(c,content_type,b,rd);free(b);return 1;}
static const char *asset_content_type(const char *path){const char *extension=strrchr(path,'.');if(!extension)return "application/octet-stream";if(!strcasecmp(extension,".png"))return "image/png";if(!strcasecmp(extension,".jpg")||!strcasecmp(extension,".jpeg"))return "image/jpeg";if(!strcasecmp(extension,".svg"))return "image/svg+xml";if(!strcasecmp(extension,".webp"))return "image/webp";return "application/octet-stream";}

static void serve_events(int c,int variables){
    const char *header="HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-store\r\nAccess-Control-Allow-Origin: *\r\nX-Accel-Buffering: no\r\nConnection: keep-alive\r\n\r\n";
    const struct timespec delay={.tv_sec=0,.tv_nsec=variables?20000000L:10000000L};
    if(!send_all(c,header,strlen(header)))return;
    while(keep_running){
        size_t capacity=variables?65536U:8192U;char *body=malloc(capacity);if(!body)return;
        int length=variables?variables_json(body,capacity):state_json(body,capacity);
        int ok=send_all(c,"data: ",6)&&send_all(c,body,(size_t)length)&&send_all(c,"\n\n",2);
        free(body);if(!ok)return;nanosleep(&delay,NULL);
    }
}
static int serve(int c,const char *default_html){char req[4096]={0};if(read(c,req,sizeof(req)-1)<=0)return 0;char*p=strchr(req,' ');if(!p)return 0;p++;char*e=strchr(p,' ');if(e)*e=0;
    if(!strncmp(p,"/api/events/state",17)){serve_events(c,0);return 0;}
    else if(!strncmp(p,"/api/events/variables",21)){serve_events(c,1);return 0;}
    else if(!strncmp(p,"/api/debug",10)){char*b=malloc(131072);int z=debug_json(b,131072);respond(c,"application/json",b,(size_t)z);free(b);}
    else if(!strncmp(p,"/api/control",12)){char action[40]={0};char*q=strstr(p,"action=");if(q)sscanf(q+7,"%39[^&]",action);debug_control(action);char*b=malloc(131072);int z=debug_json(b,131072);respond(c,"application/json",b,(size_t)z);free(b);}
    else if(!strncmp(p,"/api/state",10)){char*b=malloc(8192);int z=state_json(b,8192);respond(c,"application/json",b,(size_t)z);free(b);}
    else if(!strncmp(p,"/api/variables",14)){char*b=malloc(65536);int z=variables_json(b,65536);respond(c,"application/json",b,(size_t)z);free(b);}
    else if(!strncmp(p,"/api/panel-config",17)){if(!respond_file(c,panel_config_path,"application/json; charset=utf-8")){const char*m="{\"areas\":{}}";respond(c,"application/json",m,strlen(m));}}
    else if(!strncmp(p,"/api/pid-config",15)){if(!respond_file(c,pid_config_path,"application/json; charset=utf-8")){const char*m="{\"items\":[]}";respond(c,"application/json",m,strlen(m));}}
    else if(!strncmp(p,"/assets/",8)){char relative[PATH_MAX]={0},asset[PATH_MAX]={0};sscanf(p+8,"%4095[^?]",relative);if(strstr(relative,"..")||strchr(relative,'\\')){const char*m="Asset inválido";respond(c,"text/plain; charset=utf-8",m,strlen(m));}else{snprintf(asset,sizeof asset,"%s/assets/%s",panel_dir,relative);if(!respond_file(c,asset,asset_content_type(asset))){const char*m="Asset não encontrado";respond(c,"text/plain; charset=utf-8",m,strlen(m));}}}
    else if(!strncmp(p,"/api/force",10)){char tag[192]={0},val[80]={0},enabled[16]={0};char*q=strstr(p,"tag=");char*v=strstr(p,"val=");char*x=strstr(p,"enabled=");if(q)sscanf(q+4,"%191[^&]",tag);if(v)sscanf(v+4,"%79[^&]",val);if(x)sscanf(x+8,"%15[^&]",enabled);int ok=set_force(tag,val,atoi(enabled)!=0);const char*r=ok?"{\"ok\":true}":"{\"ok\":false}";respond(c,"application/json",r,strlen(r));}
    else if(!strncmp(p,"/api/set",8)){
        char tag[160]={0},val[80]={0};char*q=strstr(p,"tag=");char*v=strstr(p,"val=");
        if(q)sscanf(q+4,"%159[^&]",tag);if(v)sscanf(v+4,"%79[^&]",val);
        int ok=set_tag(tag,val);
        if(ok){
            unsigned long written_at;
            pthread_mutex_lock(&memory_lock);written_at=__tick;pthread_mutex_unlock(&memory_lock);
            for(int i=0;i<20;i++){unsigned long now;pthread_mutex_lock(&memory_lock);now=__tick;pthread_mutex_unlock(&memory_lock);if(now!=written_at)break;usleep(1000);}
            char state[8192],body[8320];int state_length=state_json(state,sizeof state);
            int length=snprintf(body,sizeof body,"{\"ok\":true,\"state\":%.*s}",state_length,state);
            respond(c,"application/json",body,(size_t)length);
        }else{const char*r="{\"ok\":false}";respond(c,"application/json",r,strlen(r));}
    }
    else if(!respond_file(c,default_html,"text/html; charset=utf-8")){const char*m="Visualização não encontrada";respond(c,"text/plain; charset=utf-8",m,strlen(m));}return 1;}

typedef struct { int client; const char *default_html; } client_context_t;

static void *serve_thread(void *argument) {
    client_context_t *context = argument;
    int client = context->client;
    const char *default_html = context->default_html;
    free(context);
    int one = 1;
    struct timeval receive_timeout = { .tv_sec = 60, .tv_usec = 0 };
    struct timeval send_timeout = { .tv_sec = 5, .tv_usec = 0 };
    setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &receive_timeout, sizeof(receive_timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));
    while(keep_running&&serve(client,default_html)){}
    close(client);
    return NULL;
}

static int open_server(int port) {
    int server=socket(AF_INET,SOCK_STREAM,0),one=1;
    setsockopt(server,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
    struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_port=htons((uint16_t)port);address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    if(bind(server,(struct sockaddr*)&address,sizeof address)||listen(server,32)){close(server);return -1;}
    return server;
}

static void accept_client(int server,const char *default_html) {
    int client=accept(server,NULL,NULL);if(client<0)return;
    client_context_t *context=malloc(sizeof(*context));if(!context){close(client);return;}
    context->client=client;context->default_html=default_html;
    pthread_t worker;if(!pthread_create(&worker,NULL,serve_thread,context))pthread_detach(worker);else{free(context);close(client);}
}

int main(int argc,char**argv){
    int port=8100,pid_port=8101;
    for(int i=1;i<argc;i++){
        if(!strcmp(argv[i],"--port")&&i+1<argc)port=atoi(argv[++i]);
        else if(!strcmp(argv[i],"--pid-port")&&i+1<argc)pid_port=atoi(argv[++i]);
        else if(!strcmp(argv[i],"--html")&&i+1<argc)html_path=argv[++i];
        else if(!strcmp(argv[i],"--panel-config")&&i+1<argc)panel_config_path=argv[++i];
        else if(!strcmp(argv[i],"--pid-html")&&i+1<argc)pid_html_path=argv[++i];
        else if(!strcmp(argv[i],"--pid-config")&&i+1<argc)pid_config_path=argv[++i];
        else if(!strcmp(argv[i],"--panel-dir")&&i+1<argc)panel_dir=argv[++i];
        else if(!strcmp(argv[i],"--pidfile")&&i+1<argc)pid_path=argv[++i];
        else if(!strcmp(argv[i],"--portfile")&&i+1<argc)port_path=argv[++i];
        else if(!strcmp(argv[i],"--pid-portfile")&&i+1<argc)pid_port_path=argv[++i];
    }
    signal(SIGINT,stop_runtime);signal(SIGTERM,stop_runtime);config_init__();
    pthread_t scan_thread;pthread_create(&scan_thread,NULL,scan_loop,NULL);
    int panel_server=open_server(port),pid_server=open_server(pid_port);
    if(panel_server<0||pid_server<0){perror("Não foi possível abrir as portas web");keep_running=0;if(panel_server>=0)close(panel_server);if(pid_server>=0)close(pid_server);pthread_join(scan_thread,NULL);return 1;}
    printf("PLC compressor executando: comandos http://127.0.0.1:%d · P&ID http://127.0.0.1:%d\n",port,pid_port);fflush(stdout);
    if(!write_metadata(pid_path,(long)getpid())||!write_metadata(port_path,(long)port)||!write_metadata(pid_port_path,(long)pid_port)){perror("Não foi possível registrar o processo");remove_metadata();keep_running=0;close(panel_server);close(pid_server);pthread_join(scan_thread,NULL);return 1;}
    while(keep_running){fd_set set;FD_ZERO(&set);FD_SET(panel_server,&set);FD_SET(pid_server,&set);int highest=panel_server>pid_server?panel_server:pid_server;struct timeval timeout={0,200000};if(select(highest+1,&set,NULL,NULL,&timeout)>0){if(FD_ISSET(panel_server,&set))accept_client(panel_server,html_path);if(FD_ISSET(pid_server,&set))accept_client(pid_server,pid_html_path);}}
    close(panel_server);close(pid_server);pthread_mutex_lock(&debug_lock);pthread_cond_broadcast(&debug_condition);pthread_mutex_unlock(&debug_lock);pthread_join(scan_thread,NULL);remove_metadata();puts("PLC parado.");return 0;
}
