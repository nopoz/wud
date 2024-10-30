# Script

The `script` trigger executes a local script file mounted inside the WUD container. 

Parameters passed to the script are "\<container name\>" "\<current version\>" "\<upgrade version\>".

For example, `/script/myscript.sh "plex" "1.0.0" "2.0.0"`

Supported shells for scripts are `/bin/bash`, `/bin/ash`, and `/bin/sh`. 

#### Variables

| Env var                                         |    Required    | Description                                                              | Supported values             | Default value when missing |
|-------------------------------------------------|:--------------:|--------------------------------------------------------------------------|------------------------------|----------------------------| 
| `WUD_TRIGGER_SCRIPT_{trigger_name}_PATH`        |  :red_circle:  | The absolute path with script file name                                  | Any local path               |                            |
| `WUD_TRIGGER_SCRIPT_{trigger_name}_INSTALL`     | :white_circle: | If `true`, makes this a manual Update button trigger in the UI\*         | `true`, `false`              | `false`                     |
| `WUD_TRIGGER_SCRIPT_{trigger_name}_TIMEOUT`     | :white_circle: | The amount of time in milliseconds before considering a script timed out | integer in ms                | `5000`                    |

\* By setting the INSTALL variable to `true`, this trigger is only executed manually in the containers UI page by clicking the "Update" button next to the upgrade version. Typical scheduled watch triggers for this trigger will not occur when INSTALL is `true`. Only one INSTALL variable can be set across all trigger types - if more than one is set the UI will throw an error and the trigger will not be executed. 

?> This trigger also supports the [common configuration variables](configuration/triggers/?id=common-trigger-configuration).

### Examples

#### Specify the local script file inside the WUD container 

<!-- tabs:start -->
#### **Docker Compose**
```yaml
version: '3'

services:
  whatsupdocker:
    image: getwud/wud
    ...
    environment:
      - WUD_TRIGGER_SCRIPT_MYSCRIPT_PATH=/script/myscript.sh
      - WUD_TRIGGER_SCRIPT_MYSCRIPT_INSTALL=true
    volumes:
      - /hostpath/myscript.sh:/script/myscript.sh
```
#### **Docker**
```bash
docker run \
-e WUD_TRIGGER_SCRIPT_MYSCRIPT_PATH=/script/myscript.sh \
-e WUD_TRIGGER_SCRIPT_MYSCRIPT_INSTALL=true \
-v /hostpath/myscript.sh:/script/myscript.sh \
getwud/wud
```
<!-- tabs:end -->

#### Example of parameters passed to script - container name, current version, upgrade version
```bash
/script/myscript.sh "plex" "1.0.0" "2.0.0"
```
