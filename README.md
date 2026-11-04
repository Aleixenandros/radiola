# Radiola

**Español** · [English](README.en.md)

Radio por internet en la barra superior de GNOME.

- **Más de 50 000 emisoras de todo el mundo** gracias al directorio libre
  [radio-browser.info](https://www.radio-browser.info): búscalas por nombre
  o mira las más populares de tu país.
- **Favoritas**: guárdalas con la estrella, ordénalas y edítalas.
- **Emisoras personalizadas** para las que no están en el directorio:
  dirección del stream (también listas `.pls` y `.m3u`), nombre y logo
  opcional, ya sea una imagen de tus archivos o su dirección web. Tienen
  su propia sección en el menú.
- **Título de la canción** que está sonando, con opción de verlo en la
  barra superior, copiarlo o recibir una notificación cuando cambia.
- **Teclas multimedia y controles estándar (MPRIS)**: funciona con las
  teclas de tu teclado, con los controles multimedia de GNOME y con otras
  extensiones como [Unified Panel](https://github.com/Aleixenandros/unified-panel).
  Siguiente y anterior recorren tus favoritas y emisoras personalizadas.
- **Sigue sonando con la pantalla bloqueada**. El menú no se muestra en la
  pantalla de bloqueo.
- Copia de seguridad: exporta e importa tus favoritas y emisoras
  personalizadas en JSON.

Compatible con **GNOME Shell 51**.

## Instalación

Comprueba tu versión con `gnome-shell --version`.

### Opción 1: desde extensions.gnome.org

Cuando esté aprobada, se podrá instalar con un clic desde
[extensions.gnome.org](https://extensions.gnome.org) o desde la aplicación
**Gestor de extensiones**, buscando «Radiola».

### Opción 2: desde una versión publicada

1. Descarga `radiola@aleixenandros.me.shell-extension.zip` de la
   [última versión](https://github.com/Aleixenandros/radiola/releases/latest).
2. Instálala y actívala:

   ```sh
   gnome-extensions install --force radiola@aleixenandros.me.shell-extension.zip
   gnome-extensions enable radiola@aleixenandros.me
   ```

3. Cierra sesión y vuelve a entrar.

### Opción 3: desde el código

No hace falta compilar código ni instalar Node.js: el script `build.sh`
empaqueta e instala la extensión con las herramientas estándar de GNOME.

```sh
git clone https://github.com/Aleixenandros/radiola.git
cd radiola
./build.sh
```

Sin argumentos muestra un menú con las opciones más comunes. También se
puede usar directamente:

| Comando                  | Qué hace                                              |
|--------------------------|-------------------------------------------------------|
| `./build.sh install -e`  | Compila, instala y activa la extensión                |
| `./build.sh install`     | Compila e instala                                     |
| `./build.sh build`       | Solo compila el `.zip` en `build/`                    |
| `./build.sh status`      | Versión, compatibilidad con tu GNOME y estado         |
| `./build.sh prefs`       | Abre las preferencias                                 |
| `./build.sh uninstall`   | Desinstala                                            |
| `./build.sh help`        | Todos los comandos                                    |

Si falta alguna herramienta, el script te dice el comando exacto para
instalarla en Fedora, Debian/Ubuntu, Arch u openSUSE.

Al terminar, cierra sesión y vuelve a entrar para cargar la versión nueva
(en Wayland es necesario).

Para actualizar más adelante:

```sh
git pull
./build.sh install
```

Si prefieres `make`, existen los mismos atajos (`make install`, `make pack`…).

### Requisitos

GStreamer con los complementos habituales para MP3 y AAC, y `gjs`. En
Fedora y en la mayoría de distribuciones ya vienen instalados con GNOME.

### Desinstalar

```sh
gnome-extensions uninstall radiola@aleixenandros.me
```

o `./build.sh uninstall` si la instalaste desde el código.

## Uso

- Pulsa el icono de la radio en la barra superior.
- **Descubrir emisoras** muestra las populares de tu país; escribe para
  buscar por nombre. Pulsa una emisora para escucharla.
- Pulsa la **estrella** para guardar la emisora que suena en favoritas.
- Desde **Preferencias** puedes ordenar, editar, quitar, exportar e importar
  favoritas, y elegir el país de las populares.

## Privacidad

Radiola se conecta a:

- **radio-browser.info**, para buscar emisoras y listar las populares. Al
  reproducir una emisora del directorio se lo comunica a radio-browser.info,
  como pide su API para calcular las más escuchadas.
- **La emisora que escuchas**, para recibir el audio y su logo. Los logos se
  guardan en `~/.cache/radiola` para no descargarlos cada vez.

No recoge ni envía ningún otro dato.

## Publicar una versión

Desde `main`, sin cambios pendientes:

```sh
make release VERSION=1.1
```

Esto cambia `version-name` en `metadata.json`, comprueba que el paquete se
genera bien, hace el commit, crea la etiqueta `v1.1` y la sube. Al recibir
la etiqueta, GitHub Actions (`.github/workflows/release.yml`) genera el
`.zip` y crea la *Release* en GitHub con las notas de los cambios.

Después, descarga el `.zip` de la Release y súbelo a mano en
<https://extensions.gnome.org/upload/>, que no permite subidas
automáticas. El número `version` lo asigna extensions.gnome.org; nosotros
solo controlamos `version-name`.

## Estructura del proyecto

```
extension.js          controlador: une reproductor, menú, MPRIS y notificaciones
prefs.js              ventana de preferencias (libadwaita)
lib/player.js         reproductor: controla el proceso de reproducción
lib/playerHelper.js   proceso de reproducción (GStreamer playbin), fuera de GNOME Shell
lib/mpris.js          servidor MPRIS en D-Bus
lib/indicator.js      botón de la barra superior y su menú
lib/radioBrowser.js   cliente de radio-browser.info
lib/stations.js       favoritas guardadas en GSettings
lib/favicons.js       caché de logos en ~/.cache/radiola
lib/logos.js          logos elegidos por el usuario, copiados en ~/.local/share/radiola/logos
lib/http.js           utilidades HTTP (libsoup 3) y listas .pls/.m3u
icons/                icono de la extensión
schemas/              esquema GSettings (todas las opciones)
po/                   traducciones (es)
build.sh              compilar, instalar, traducir (lo usa también el Makefile)
.github/workflows/    publicación automática de versiones
```

## Cómo funciona (para colaboradores)

- `prefs.js` comparte con la extensión `lib/stations.js`,
  `lib/radioBrowser.js` y `lib/http.js`, que solo dependen de GLib y
  libsoup. No importes nada de GNOME Shell en esos tres módulos.
- **Pantalla de bloqueo**: la extensión declara `unlock-dialog` en
  `session-modes` para que la música siga sonando con la pantalla
  bloqueada (el menú se oculta). Al iniciar sesión, GNOME activa primero
  las extensiones que funcionan en la pantalla de bloqueo, así que
  bloquear no desactiva Radiola. `disable()` siempre lo para y destruye
  todo. Si se activa a mitad de sesión, hasta el siguiente inicio de
  sesión la música se para al bloquear.
- **GStreamer nunca se carga dentro de GNOME Shell.** `lib/player.js`
  lanza `lib/playerHelper.js` con `gjs -m` al reproducir y le habla por
  stdin/stdout (una línea JSON por mensaje). El primer `Gst.init()` de
  cada arranque reescanea plugins que dependen de `/dev/dri` (Vulkan,
  VA-API); el escáner se conecta al servidor Wayland, que dentro de la
  shell es la propia shell bloqueada esperándolo: la sesión se congela
  al iniciar. No importes `gi://Gst` en ningún módulo que cargue la shell.
- **radio-browser.info** pide identificarse con un User-Agent y avisar de
  cada reproducción (`/json/url/<id>`). Radiola solo avisa si el usuario
  activa «Ayudar a ordenar el directorio» en las preferencias (desactivado
  por defecto). El cliente reparte las peticiones entre varios espejos y
  reintenta si alguno falla.

Pautas:
- JavaScript moderno sin compilar (módulos ES), siguiendo el estilo de código
  de GNOME Shell.
- Todo lo que se cambia en `enable()` debe deshacerse en `disable()`.
- Los textos visibles pasan por `_()`; ejecuta `./build.sh pot` después de
  cambiarlos.

## Créditos

Inspirada en [Internet Radio](https://github.com/hslbck/gnome-shell-extension-radio)
de hslbck. Radiola es una implementación nueva, escrita desde cero para
GNOME 51.

Directorio de emisoras: [radio-browser.info](https://www.radio-browser.info).

## Licencia

Apache-2.0. Consulta el archivo [LICENSE](LICENSE).
