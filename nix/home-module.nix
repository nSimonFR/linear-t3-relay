# One relay per Linear workspace, as a launchd agent (macOS) or a systemd user
# service (Linux), next to the T3 Code server it drives.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.linear-t3-relay;

  instance = lib.types.submodule (
    { name, ... }:
    {
      options = {
        port = lib.mkOption {
          type = lib.types.port;
          description = "Local port; put public HTTPS (BASE_URL) in front of it.";
        };
        environmentFile = lib.mkOption {
          type = lib.types.str;
          description = ''
            File with the instance's secrets and settings (Linear app, BASE_URL,
            INSTALL_SECRET, T3CODE_PROJECT, ALLOWED_USER_IDS…), e.g. an agenix path.
            Expanded by the shell, so `$(getconf DARWIN_USER_TEMP_DIR)`-style paths work.
          '';
        };
        t3Url = lib.mkOption {
          type = lib.types.str;
          default = "http://127.0.0.1:3773";
        };
        renewCommand = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "t3 auth pairing create --json --ttl 5m --scope orchestration:read --scope orchestration:operate";
          description = "Prints a T3 pairing code; the relay then signs in and renews its bearer by itself.";
        };
        stateDir = lib.mkOption {
          type = lib.types.str;
          default = "${config.xdg.stateHome}/linear-t3-relay/${name}";
          description = "Holds the Linear install and the T3 bearer; keep it.";
        };
      };
    }
  );

  start =
    name: i:
    pkgs.writeShellApplication {
      name = "linear-t3-relay-${name}";
      runtimeInputs = [ pkgs.git ];
      text = ''
        ENV_FILE="${i.environmentFile}"
        export ENV_FILE
        install -d -m 700 "${i.stateDir}"
        export HOST=127.0.0.1 PORT=${toString i.port}
        export STATE_PATH="${i.stateDir}/state.json"
        export T3CODE_URL="${i.t3Url}"
        ${lib.optionalString (i.renewCommand != null) "export T3CODE_RENEW_COMMAND=${lib.escapeShellArg i.renewCommand}"}
        exec ${lib.getExe cfg.package}
      '';
    };
in
{
  options.services.linear-t3-relay = {
    enable = lib.mkEnableOption "linear-t3-relay";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };
    instances = lib.mkOption {
      type = lib.types.attrsOf instance;
      default = { };
    };
  };

  config = lib.mkIf cfg.enable {
    launchd.agents = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin (
      lib.mapAttrs' (
        name: i:
        lib.nameValuePair "linear-t3-relay-${name}" {
          enable = true;
          config = {
            ProgramArguments = [ (lib.getExe (start name i)) ];
            RunAtLoad = true;
            KeepAlive = true;
            # A secrets file decrypted by another agent may not exist yet; retry.
            ThrottleInterval = 30;
            StandardOutPath = "${config.home.homeDirectory}/Library/Logs/linear-t3-relay-${name}.log";
            StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/linear-t3-relay-${name}.log";
          };
        }
      ) cfg.instances
    );

    systemd.user.services = lib.mkIf pkgs.stdenv.hostPlatform.isLinux (
      lib.mapAttrs' (
        name: i:
        lib.nameValuePair "linear-t3-relay-${name}" {
          Unit.Description = "linear-t3-relay (${name})";
          Service = {
            ExecStart = lib.getExe (start name i);
            Restart = "always";
            RestartSec = 30;
          };
          Install.WantedBy = [ "default.target" ];
        }
      ) cfg.instances
    );
  };
}
