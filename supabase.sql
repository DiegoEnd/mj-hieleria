-- ===== Portal MJ Hieleria · ejecutar una sola vez en Supabase > SQL Editor =====
create table public.hielo_admins (
  email text primary key,
  nombre text,
  created_at timestamptz not null default now()
);

create or replace function public.hielo_es_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.hielo_admins a where lower(a.email) = lower(auth.jwt()->>'email'));
$$;

-- El primer usuario que entre se convierte en dueño del portal (solo si no hay ninguno)
create or replace function public.hielo_reclamar_portal() returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_email text := auth.jwt()->>'email';
begin
  if v_email is null then return false; end if;
  if exists(select 1 from public.hielo_admins) then
    return exists(select 1 from public.hielo_admins a where lower(a.email) = lower(v_email));
  end if;
  insert into public.hielo_admins(email, nombre) values (lower(v_email), 'Dueño');
  return true;
end $$;

create table public.hielo_empresa (
  id int primary key default 1 check (id = 1),
  nombre text not null default 'MJ HIELERIA SAC',
  ruc text, telefono text, direccion text,
  precio_15 numeric(10,2) not null default 3.00,
  precio_3 numeric(10,2) not null default 5.00,
  stock_minimo_15 int not null default 50,
  stock_minimo_3 int not null default 30,
  mensaje_recordatorio text not null default 'Hola {nombre} 👋, le saluda MJ Hielería. Han pasado {dias} días desde su último pedido. ¿Desea que le enviemos hielo? Tenemos bolsas de 1.5 kg y 3 kg listas 🧊',
  updated_at timestamptz not null default now()
);
insert into public.hielo_empresa(id) values (1);

create table public.hielo_clientes (
  id bigint generated always as identity primary key,
  nombre text not null,
  telefono text,
  distrito text,
  direccion text,
  referencia text,
  tipo text default 'Bodega',
  frecuencia_dias int not null default 7,
  precio_15 numeric(10,2),
  precio_3 numeric(10,2),
  notas text,
  activo boolean not null default true,
  ultimo_recordatorio date,
  created_at timestamptz not null default now()
);
create index on public.hielo_clientes (telefono);

create table public.hielo_ventas (
  id bigint generated always as identity primary key,
  fecha date not null default (now() at time zone 'America/Lima')::date,
  cliente_id bigint references public.hielo_clientes(id) on delete set null,
  cant_15 int not null default 0 check (cant_15 >= 0),
  cant_3 int not null default 0 check (cant_3 >= 0),
  precio_15 numeric(10,2) not null default 0,
  precio_3 numeric(10,2) not null default 0,
  total numeric(12,2) generated always as (cant_15 * precio_15 + cant_3 * precio_3) stored,
  monto_pagado numeric(12,2) not null default 0,
  metodo_pago text default 'Efectivo',
  canal text default 'WhatsApp',
  entrega text default 'Delivery',
  distrito text,
  notas text,
  created_at timestamptz not null default now()
);
create index on public.hielo_ventas (fecha);
create index on public.hielo_ventas (cliente_id);

create table public.hielo_movimientos_stock (
  id bigint generated always as identity primary key,
  fecha date not null default (now() at time zone 'America/Lima')::date,
  tipo text not null check (tipo in ('Producción','Merma','Ajuste')),
  cant_15 int not null default 0,
  cant_3 int not null default 0,
  notas text,
  created_at timestamptz not null default now()
);

create table public.hielo_prestamos (
  id bigint generated always as identity primary key,
  acreedor text not null,
  monto numeric(12,2) not null,
  fecha date not null default (now() at time zone 'America/Lima')::date,
  n_cuotas int not null default 1,
  monto_cuota numeric(12,2),
  notas text,
  created_at timestamptz not null default now()
);

create table public.hielo_cuentas_pagar (
  id bigint generated always as identity primary key,
  concepto text not null,
  categoria text default 'Otros',
  detalle text,
  monto numeric(12,2) not null,
  vencimiento date not null,
  tipo text not null default 'Fijo' check (tipo in ('Fijo','Variable')),
  prestamo_id bigint references public.hielo_prestamos(id) on delete cascade,
  pagado boolean not null default false,
  fecha_pago date,
  created_at timestamptz not null default now()
);
create index on public.hielo_cuentas_pagar (vencimiento);

create table public.hielo_gastos (
  id bigint generated always as identity primary key,
  fecha date not null default (now() at time zone 'America/Lima')::date,
  categoria text not null default 'Otros',
  descripcion text,
  monto numeric(12,2) not null,
  tipo text not null default 'Variable' check (tipo in ('Fijo','Variable','Préstamo')),
  cuenta_pagar_id bigint references public.hielo_cuentas_pagar(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.hielo_gastos (fecha);

-- Seguridad: solo los correos en hielo_admins pueden ver/editar
do $$ declare t text;
begin
  foreach t in array array['hielo_admins','hielo_empresa','hielo_clientes','hielo_ventas','hielo_movimientos_stock','hielo_prestamos','hielo_cuentas_pagar','hielo_gastos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "%s: solo administradores del portal" on public.%I for all to authenticated using ((select public.hielo_es_admin())) with check ((select public.hielo_es_admin()))', t, t);
  end loop;
end $$;

revoke execute on function public.hielo_es_admin() from anon, public;
revoke execute on function public.hielo_reclamar_portal() from anon, public;
grant execute on function public.hielo_es_admin() to authenticated;
grant execute on function public.hielo_reclamar_portal() to authenticated;

-- Stock actual = producción - merma + ajustes - vendido
create view public.hielo_stock with (security_invoker = true) as
select
  coalesce((select sum(case when tipo='Merma' then -cant_15 else cant_15 end) from public.hielo_movimientos_stock),0)
    - coalesce((select sum(cant_15) from public.hielo_ventas),0) as stock_15,
  coalesce((select sum(case when tipo='Merma' then -cant_3 else cant_3 end) from public.hielo_movimientos_stock),0)
    - coalesce((select sum(cant_3) from public.hielo_ventas),0) as stock_3;

-- Resumen por cliente: última compra, total comprado, deuda
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

-- Proyección de pagos de noviembre 2026
insert into public.hielo_cuentas_pagar (concepto, categoria, detalle, monto, vencimiento, tipo) values
 ('Congeladora','Equipos','4ª cuota',533.33,'2026-11-30','Fijo'),
 ('Máquinas de hielo','Equipos','2ª cuota',1500,'2026-11-30','Fijo'),
 ('Luz','Servicios','Noviembre – puede aumentar o disminuir',1500,'2026-11-30','Variable'),
 ('Agua','Servicios','Noviembre – puede aumentar o disminuir',75,'2026-11-30','Variable'),
 ('Alquiler local','Alquiler','Noviembre',300,'2026-11-30','Fijo'),
 ('10 millares de bolsas','Insumos','Fijo en 10 días',1250,'2026-11-14','Fijo'),
 ('Devolución','Préstamos','Noviembre (revisar nombre)',1243,'2026-11-30','Fijo');
