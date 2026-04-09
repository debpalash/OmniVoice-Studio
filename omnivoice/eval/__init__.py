import warnings

# Suppress specific warnings from zhconv that are not relevant to WER calculation
warnings.filterwarnings("ignore", category=UserWarning)
