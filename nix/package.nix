# No runtime dependencies: the npm deps are the TypeScript toolchain, dropped after `tsc`.
{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs_22,
  version,
}:
buildNpmPackage {
  pname = "linear-t3-relay";
  inherit version;
  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../test
    ];
  };
  nodejs = nodejs_22;
  nativeBuildInputs = [ makeWrapper ];

  # Bump with: nix run nixpkgs#prefetch-npm-deps -- package-lock.json
  npmDepsHash = "sha256-G11RGsBOEXK/0yaNeNl9kn+QFRnYEm/TZKdCmUE0g6g=";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/linear-t3-relay $out/bin
    cp -r dist package.json $out/lib/linear-t3-relay/
    for bin in linear-t3-relay:server linear-t3-relay-login:t3-login; do
      makeWrapper ${lib.getExe nodejs_22} $out/bin/''${bin%%:*} \
        --add-flags $out/lib/linear-t3-relay/dist/''${bin##*:}.js
    done
    runHook postInstall
  '';

  meta = {
    description = "Delegate Linear issues to T3 Code";
    homepage = "https://github.com/nSimonFR/linear-t3-relay";
    license = lib.licenses.mit;
    mainProgram = "linear-t3-relay";
  };
}
