{
  description = "linear-t3-relay — delegate Linear issues to T3 Code";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.callPackage ./nix/package.nix {
          version = "0.1.0-${self.shortRev or self.dirtyShortRev or "dev"}";
        };

        checks.default = self.packages.${system}.default;

        devShells.default = pkgs.mkShell { packages = [ pkgs.nodejs_22 ]; };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/linear-t3-relay";
        };
      }
    )
    // {
      homeManagerModules.default = import ./nix/home-module.nix self;
    };
}
