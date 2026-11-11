-- ===== MJ Hieleria: emisión electrónica SUNAT (SEE-Del Contribuyente) =====
-- Ejecutar una sola vez en Supabase > SQL Editor (después de supabase.sql)

-- 1) Datos fiscales de la empresa
alter table public.hielo_empresa
  add column if not exists razon_social text,
  add column if not exists nombre_comercial text,
  add column if not exists ubigeo text not null default '150101',
  add column if not exists departamento text not null default 'LIMA',
  add column if not exists provincia text not null default 'LIMA',
  add column if not exists distrito_fiscal text not null default 'LIMA',
  add column if not exists sunat_modo text not null default 'beta',
  add column if not exists serie_factura text not null default 'F001',
  add column if not exists serie_boleta text not null default 'B001';
do $$ begin
  alter table public.hielo_empresa add constraint hielo_empresa_modo_chk check (sunat_modo in ('beta','produccion'));
exception when duplicate_object then null; end $$;

-- 2) Documento del cliente (DNI / RUC)
alter table public.hielo_clientes
  add column if not exists tipo_doc text not null default 'NINGUNO',
  add column if not exists num_doc text;
do $$ begin
  alter table public.hielo_clientes add constraint hielo_clientes_doc_chk check (tipo_doc in ('NINGUNO','DNI','RUC','CE'));
exception when duplicate_object then null; end $$;

-- 3) Ventas: precios SIN IGV -> subtotal + IGV 18% = total
drop view if exists public.hielo_clientes_resumen;
alter table public.hielo_ventas drop column if exists total;
alter table public.hielo_ventas add column if not exists con_igv boolean not null default true;
alter table public.hielo_ventas
  add column subtotal numeric(12,2) generated always as (round(cant_15*precio_15,2) + round(cant_3*precio_3,2)) stored,
  add column igv numeric(12,2) generated always as (case when con_igv then round(cant_15*precio_15*0.18,2) + round(cant_3*precio_3*0.18,2) else 0 end) stored,
  add column total numeric(12,2) generated always as (round(cant_15*precio_15,2) + round(cant_3*precio_3,2) + case when con_igv then round(cant_15*precio_15*0.18,2) + round(cant_3*precio_3*0.18,2) else 0 end) stored;

create view public.hielo_clientes_resumen with (security_invoker = true) as
select c.*,
  v.ultima_compra, coalesce(v.n_compras,0) as n_compras,
  coalesce(v.total_comprado,0) as total_comprado,
  coalesce(v.bolsas_15,0) as bolsas_15, coalesce(v.bolsas_3,0) as bolsas_3,
  coalesce(v.deuda,0) as deuda,
  ((now() at time zone 'America/Lima')::date - v.ultima_compra) as dias_sin_comprar
from public.hielo_clientes c
left join (
  select cliente_id, max(fecha) ultima_compra, count(*) n_compras, sum(total) total_comprado,
         sum(cant_15) bolsas_15, sum(cant_3) bolsas_3, sum(greatest(total - monto_pagado,0)) deuda
  from public.hielo_ventas where cliente_id is not null group by cliente_id
) v on v.cliente_id = c.id;

-- 4) Series y comprobantes electrónicos
create table if not exists public.hielo_series (
  modo text not null, serie text not null, tipo text not null, ultimo int not null default 0,
  primary key (modo, serie)
);
create table if not exists public.hielo_comprobantes (
  id bigint generated always as identity primary key,
  venta_id bigint references public.hielo_ventas(id) on delete set null,
  modo text not null default 'beta',
  tipo text not null check (tipo in ('01','03')),
  serie text not null,
  correlativo int not null,
  fecha_emision date not null,
  cliente_tipo_doc text, cliente_num_doc text, cliente_nombre text, cliente_direccion text,
  gravada numeric(12,2), igv numeric(12,2), total numeric(12,2),
  estado text not null default 'PENDIENTE' check (estado in ('PENDIENTE','ACEPTADO','OBSERVADO','RECHAZADO','ERROR')),
  sunat_codigo text, sunat_mensaje text, hash text, xml text, cdr text,
  created_at timestamptz not null default now(),
  unique (modo, serie, correlativo)
);
create index if not exists hielo_comprobantes_venta_idx on public.hielo_comprobantes (venta_id);

do $$ declare t text;
begin
  foreach t in array array['hielo_series','hielo_comprobantes'] loop
    execute format('alter table public.%I enable row level security', t);
    begin
      execute format('create policy "%s: solo administradores del portal" on public.%I for all to authenticated using ((select public.hielo_es_admin())) with check ((select public.hielo_es_admin()))', t, t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- Reserva atómica del siguiente número de la serie
create or replace function public.hielo_siguiente_correlativo(p_modo text, p_serie text, p_tipo text)
returns int language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  insert into public.hielo_series(modo, serie, tipo, ultimo) values (p_modo, p_serie, p_tipo, 1)
  on conflict (modo, serie) do update set ultimo = public.hielo_series.ultimo + 1
  returning ultimo into n;
  return n;
end $$;
revoke execute on function public.hielo_siguiente_correlativo(text,text,text) from anon, public;
grant execute on function public.hielo_siguiente_correlativo(text,text,text) to authenticated;

select 'ok' as resultado,
  (select count(*) from information_schema.columns where table_name='hielo_ventas' and column_name in ('subtotal','igv','total')) as cols_igv,
  (select count(*) from information_schema.tables where table_name in ('hielo_series','hielo_comprobantes')) as tablas;
