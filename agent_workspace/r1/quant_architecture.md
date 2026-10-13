# R1 Quantization & PLE Architecture

- Main GGUF is text-only; vision/audio projector lives in separate `mmproj`.
- Test `Q3_K_M` and `IQ3_M` with imatrix calibration before shrinking PLE tables further.
