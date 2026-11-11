# Obsidian Neon Sync (piloto)

Plugin personal para sincronizar notas Markdown de un vault de Obsidian entre Windows, Linux y Android mediante una base de datos Neon propia.

## Alcance de esta version

- Sincroniza únicamente archivos `.md`.
- No sincroniza adjuntos, `.obsidian`, papelera ni estado interno.
- Uso personal con una URL PostgreSQL de un rol restringido de Neon.
- Contenido almacenado como texto legible en Neon; HTTPS protege el transporte.
- La última operación nueva aceptada por Neon gana, incluidos borrados.
- Historial recuperable durante 30 días.
- No es un sistema de backup.

## Instalación

1. Clonar el repositorio y generar el plugin (main.js está excluido del repositorio):

   ```bash
   git clone https://github.com/mcgnexus/OBSIDIAN_NEON.git
   cd OBSIDIAN_NEON
   npm install
   npm run build
   ```

2. Crear un **vault de prueba vacío** en Obsidian (sin notas personales).

3. En la carpeta del vault, crear `.obsidian/plugins/obsidian-neon-sync/` y copiar `main.js` y `manifest.json`.

4. Reiniciar Obsidian. En **Ajustes → Plugins de terceros**, desactivar el modo restringido si aparece y localizar **Neon Sync**.

5. Crear o seleccionar un proyecto Neon y una rama de prueba.

6. Aplicar `migrations/001_sync.sql` con una conexión administrativa directa.

7. Aprovisionar un rol restringido por dispositivo con `migrations/002_device_role_template.sql` y pegar su URL en los ajustes.

## Advertencias

- El contenido es legible en Neon.
- La credencial es accesible desde el dispositivo.
- La sincronización automática puede mantener el compute activo.
- No ejecutar este plugin junto con Obsidian Sync, Syncthing, Git automatizado u otro sincronizador.
- Probar primero con una copia del vault y revisar la comparación inicial.

## Validación pendiente

- Compatibilidad HTTP y almacenamiento de secretos en Android.
- Pruebas reales contra Neon con dispositivos Windows, Linux y Android.
- Mediciones de memoria, escaneo y transferencia con un vault de 1.000 notas.
