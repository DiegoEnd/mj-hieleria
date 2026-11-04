# 🧊 MJ Hielería · Portal interno

App móvil (un solo archivo HTML) para organizar MJ HIELERIA SAC: ventas de bolsas de 1.5 kg y 3 kg, clientes, recordatorios por WhatsApp, stock, gastos fijos y variables, cuentas por pagar, préstamos y utilidades.

## Archivos
- `index.html` – la app completa. Se conecta a Supabase (proyecto **mj-hieleria**).
- `supabase.sql` – script que crea las tablas `hielo_*` (ya ejecutado; solo para reinstalar en otro proyecto).

## Uso
1. Abre la app (GitHub Pages o el archivo `index.html`).
2. La **primera cuenta** que se registre queda como dueña del portal. Luego, en ⚙ Configuración, se pueden añadir más correos con acceso.
3. En el celular: menú del navegador → **“Agregar a pantalla de inicio”** para usarla como app.

## Seguridad
La clave en `index.html` es la clave **pública** (anon) de Supabase. Los datos están protegidos con Row Level Security: solo los correos autorizados en `hielo_admins` pueden leer o escribir.
