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

1. Copiar `main.js`, `manifest.json` y `styles.css` (si existe) en `.obsidian/plugins/obsidian-neon-sync/`.
2. Activar el plugin en Obsidian.
3. Crear o seleccionar un proyecto Neon y una rama de prueba.
4. Aplicar `migrations/001_sync.sql` con una conexión administrativa directa.
5. Crear un rol restringido por dispositivo, asociarlo a `device_access` y otorgar solo ejecución de las funciones de `neon_sync`.
6. Pegar la URL del rol restringido en los ajustes.

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
