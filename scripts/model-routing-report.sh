#!/usr/bin/env bash
# Aggregate omp usage by agent_type/model/tool from stats.db. Usage: model-routing-report.sh [days] [db]
set -euo pipefail
DAYS="${1:-21}"; DB="${2:-$HOME/.omp/stats.db}"
C="timestamp > (strftime('%s','now')-${DAYS}*86400)*1000"
K="CASE WHEN folder LIKE '%tmp%' THEN 'bench' ELSE 'real' END"
q(){ sqlite3 -header -column "$DB" "$1"; echo; }
q "select $K k, agent_type, count(*) calls, count(distinct session_file) sess, round(sum(duration)/3.6e6,1) hrs, round(sum(cache_read_tokens)/1e6,0) cr_M, round(sum(cost_total),2) cost from messages where $C group by 1,2 order by cost desc;"
q "select $K k, model, agent_type, count(*) calls, round(avg(duration)/1000,1) avg_s, round(avg(input_tokens+cache_read_tokens)/1000,0) ctxK, round(sum(cost_total),2) cost, sum(stop_reason='error') errs from messages where $C group by 1,2,3 order by cost desc limit 30;"
q "select round(sum(cost_input),2) input, round(sum(cost_output),2) output, round(sum(cost_cache_read),2) cache_read, round(sum(cost_cache_write),2) cache_write from messages where $C;"
q "select model, agent_type, tool_name, count(*) n, sum(is_error) err from tool_calls where $C group by 1,2,3 having n>50 order by n desc limit 30;"
