#!/usr/bin/env python3
"""Convert official MiDaS v2.1 small frozen graph to TF.js uint8 shards."""

import sys
from types import ModuleType

import numpy as np

np.object = object
np.bool = bool
sys.modules["tensorflow_hub"] = ModuleType("tensorflow_hub")

from tensorflowjs.converters.tf_saved_model_conversion_v2 import convert_tf_frozen_model

convert_tf_frozen_model(
    sys.argv[1],
    "797",
    sys.argv[2],
    quantization_dtype_map={"uint8": "*"},
    skip_op_check=True,
    strip_debug_ops=True,
)
