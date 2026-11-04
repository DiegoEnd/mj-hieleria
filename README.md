# 🧊 MJ Hielería · Portal interno

App móvil (un solo archivo HTML) para organizar MJ HIELERIA SAC: ventas de bolsas de 1.5 kg y 3 kg, clientes, recordatorios por WhatsApp, stock, gastos fijos y variables, cuentas por pagar, préstamos y utilidades.

## Archivos
- `index.html` – la app completa. Se conecta a Supabase (proyecto **mj-hieleria**).
- `supabase.sql` – script que crea las tablas `hielo_*` (ya ejecutado; solo para reinstalar en otro proyecto).

## Uso
1. Abre la app: https://diegoend.github.io/mj-hieleria/
2. Se ingresa con **usuario y contraseña** (sin correo). Las cuentas se crean en Supabase → Authentication → **Add user → Create new user**:
   - Email: `usuario@mjhieleria.app` (ej. `admin@mjhieleria.app` → en la app se escribe solo `admin`)
   - Password: la clave que quieras
   - Marca **Auto Confirm User**
3. El **primer usuario** que ingrese queda como dueño del portal. Para dar acceso a otros: ⚙ Configuración → Usuarios con acceso, y crea ese usuario en Supabase igual que arriba.
4. En el celular: menú del navegador → **“Agregar a pantalla de inicio”** para usarla como app.

## Seguridad
La clave en `index.html` es la clave **pública** (anon) de Supabase. Los datos están protegidos con Row Level Security: solo los correos autorizados en `hielo_admins` pueden leer o escribir.
