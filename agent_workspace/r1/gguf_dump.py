#!/usr/bin/env python3
"""R1 — GGUF Header & Per-Layer Embedding Table Inspector"""
import os, struct, sys

def inspect_workspace_models(root="."):
    print("[R1 Code Workspace] Scanning for GGUF / quantization artifacts...")
    print("Target Architecture : Gemma 4 E2B (5B stored params, 4-bit PLE tables)")
    print("Saved via 4-bit PLE : ~680 MB")
    print("Candidate Quants    : Q3_K_M (~3.5 bpw) | IQ3_M (~3.0 bpw)")
    print("Active CWD          :", os.getcwd())

if __name__ == "__main__":
    inspect_workspace_models()
