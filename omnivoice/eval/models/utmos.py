#!/usr/bin/env python3
# Copyright    2026  Xiaomi Corp.        (authors:  Han Zhu)
#
# See ../../LICENSE for clarification regarding multiple authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
UTMOS strong model.
Implementation from https://github.com/tarepan/SpeechMOS

"""

import math
from typing import List, Optional, Tuple

import torch
import torch.nn.functional as F
from torch import Tensor, nn


class UTMOS22Strong(nn.Module):
    """Saeki_2022 paper's `UTMOS strong learner` inference model
    (w/o Phoneme encoder)."""

    def __init__(self):
        """Init."""

        super().__init__()  # pyright: ignore [reportUnknownMemberType]

        feat_ssl, feat_domain_emb, feat_judge_emb, feat_rnn_h, feat_proj_h = (
            768,
            128,
            128,
            512,
            2048,
        )
        feat_cat = feat_ssl + feat_domain_emb + feat_judge_emb

        # SSL/DataDomainEmb/JudgeIdEmb/BLSTM/Projection
        self.wav2vec2 = Wav2Vec2Model()
        self.domain_emb = nn.Parameter(
            data=torch.empty(1, feat_domain_emb), requires_grad=False
        )
        self.judge_emb = nn.Parameter(
            data=torch.empty(1, feat_judge_emb), requires_grad=False
        )
        self.blstm = nn.LSTM(
            input_size=feat_cat,
            hidden_size=feat_rnn_h,
            batch_first=True,
            bidirectional=True,
        )
        self.projection = nn.Sequential(
            nn.Linear(feat_rnn_h * 2, feat_proj_h), nn.ReLU(), nn.Linear(feat_proj_h, 1)
        )

    def forward(self, wave: Tensor, sr: int) -> Tensor:  # pylint: disable=invalid-name
        """wave-to-score :: (B, T) -> (B,)"""

        # Feature extraction :: (B, T) -> (B, Frame, Feat)
        unit_series = self.wav2vec2(wave)
        bsz, frm, _ = unit_series.size()

        # DataDomain/JudgeId Embedding's Batch/Time expansion ::
        # (B=1, Feat) -> (B=bsz, Frame=frm, Feat)
        domain_series = self.domain_emb.unsqueeze(1).expand(bsz, frm, -1)
        judge_series = self.judge_emb.unsqueeze(1).expand(bsz, frm, -1)

        # Feature concatenation :: (B, Frame, Feat=f1) + (B, Frame, Feat=f2) +
        # (B, Frame, Feat=f3) -> (B, Frame, Feat=f1+f2+f3)
        cat_series = torch.cat([unit_series, domain_series, judge_series], dim=2)

        # Frame-scale score estimation :: (B, Frame, Feat) -> (B, Frame, Feat)
        # -> (B, Frame, Feat=1) - BLSTM/Projection
        feat_series = self.blstm(cat_series)[0]
        score_series = self.projection(feat_series)

        # Utterance-scale score :: (B, Frame, Feat=1) -> (B, Feat=1)
        # -> (B,) - Time averaging
        utter_score = score_series.mean(dim=1).squeeze(1) * 2 + 3

        return utter_score


class Wav2Vec2Model(nn.Module):
    """Wav2Vev2."""

    def __init__(self):
        super().__init__()  # pyright: ignore [reportUnknownMemberType]

        feat_h1, feat_h2 = 512, 768
        feature_enc_layers = (
            [(feat_h1, 10, 5)] + [(feat_h1, 3, 2)] * 4 + [(feat_h1, 2, 2)] * 2
        )

        self.feature_extractor = ConvFeatureExtractionModel(
            conv_layers=feature_enc_layers
        )  # pyright: ignore [reportGeneralTypeIssues]
        self.layer_norm = nn.LayerNorm(feat_h1)
        self.post_extract_proj = nn.Linear(feat_h1, feat_h2)
        self.dropout_input = nn.Dropout(0.1)
        self.encoder = TransformerEncoder(feat_h2)

        # Remnants
        self.mask_emb = nn.Parameter(torch.FloatTensor(feat_h2))

    def forward(self, source: Tensor):
        """FeatureEncoder + ContextTransformer"""

        # Feature encoding
        features = self.feature_extractor(source)
        features = features.transpose(1, 2)
        features = self.layer_norm(features)
        features = self.post_extract_proj(features)

        # Context transformer
        x = self.encoder(features)

        return x


class ConvFeatureExtractionModel(nn.Module):
    """Feature Encoder."""

    def __init__(self, conv_layers: List[Tuple[int, int, int]]):
        super().__init__()  # pyright: ignore [reportUnknownMemberType]

        def block(
            n_in: int, n_out: int, k: int, stride: int, is_group_norm: bool = False
        ):
            if is_group_norm:
                return nn.Sequential(
                    nn.Conv1d(n_in, n_out, k, stride=stride, bias=False),
                    nn.Dropout(p=0.0),
                    nn.GroupNorm(dim, dim, affine=True),
                    nn.GELU(),
                )
            else:
                return nn.Sequential(
                    nn.Conv1d(n_in, n_out, k, stride=stride, bias=False),
                    nn.Dropout(p=0.0),
                    nn.GELU(),
                )

        in_d = 1
        self.conv_layers = nn.ModuleList()
        for i, params in enumerate(conv_layers):
            (dim, k, stride) = params
            self.conv_layers.append(block(in_d, dim, k, stride, is_group_norm=i == 0))
            in_d = dim

    def forward(self, series: Tensor) -> Tensor:
        """:: (B, T) -> (B, Feat, Frame)"""

        series = series.unsqueeze(1)
        for conv in self.conv_layers:
            series = conv(series)

        return series


class TransformerEncoder(nn.Module):
    """Transformer."""

    def build_encoder_layer(self, feat: int):
        """Layer builder."""
        return TransformerSentenceEncoderLayer(
            embedding_dim=feat,
            ffn_embedding_dim=3072,
            num_attention_heads=12,
            activation_fn="gelu",
            dropout=0.1,
            attention_dropout=0.1,
            activation_dropout=0.0,
            layer_norm_first=False,
        )

    def __init__(self, feat: int):
        super().__init__()  # pyright: ignore [reportUnknownMemberType]

        self.required_seq_len_multiple = 2

        self.pos_conv = nn.Sequential(
            *[
                nn.utils.weight_norm(
                    nn.Conv1d(feat, feat, kernel_size=128, padding=128 // 2, groups=16),
                    name="weight",
                    dim=2,
                ),
                SamePad(128),
                nn.GELU(),
            ]
        )
        self.layer_norm = nn.LayerNorm(feat)
        self.layers = nn.ModuleList([self.build_encoder_layer(feat) for _ in range(12)])

    def forward(self, x: Tensor) -> Tensor:

        x_conv = self.pos_conv(x.transpose(1, 2)).transpose(1, 2)
        x = x + x_conv

        x = self.layer_norm(x)

        # pad to the sequence length dimension
        x, pad_length = pad_to_multiple(
            x, self.required_seq_len_multiple, dim=-2, value=0
        )
        if pad_length > 0:
            padding_mask = x.new_zeros((x.size(0), x.size(1)), dtype=torch.bool)
            padding_mask[:, -pad_length:] = True
        else:
            padding_mask, _ = pad_to_multiple(
                None, self.required_seq_len_multiple, dim=-1, value=True
            )

        # :: (B, T, Feat) -> (T, B, Feat)
        x = x.transpose(0, 1)
        for layer in self.layers:
            x = layer(x, padding_mask)
        # :: (T, B, Feat) -> (B, T, Feat)
        x = x.transpose(0, 1)

        # undo paddding
        if pad_length > 0:
            x = x[:, :-pad_length]

        return x


class SamePad(nn.Module):
    """Tail inverse padding."""

    def __init__(self, kernel_size: int):
        super().__init__()  # pyright: ignore [reportUnknownMemberType]
        assert kernel_size % 2 == 0, "`SamePad` now support only even kernel."

    def forward(self, x: Tensor) -> Tensor:
        return x[:, :, :-1]


def pad_to_multiple(
    x: Optional[Tensor], multiple: int, dim: int = -1, value: float = 0
) -> Tuple[Optional[Tensor], int]:
    """Tail padding."""
    if x is None:
        return None, 0
    tsz = x.size(dim)
    m = tsz / multiple
    remainder = math.ceil(m) * multiple - tsz
    if m.is_integer():
        return x, 0
    pad_offset = (0,) * (-1 - dim) * 2

    return F.pad(x, (*pad_offset, 0, remainder), value=value), remainder


class TransformerSentenceEncoderLayer(nn.Module):
    """Transformer Encoder Layer used in BERT/XLM style pre-trained models."""

    def __init__(
        self,
        embedding_dim: int,
        ffn_embedding_dim: int,
        num_attention_heads: int,
        activation_fn: str,
        dropout: float,
        attention_dropout: float,
        activation_dropout: float,
        layer_norm_first: bool,
    ) -> None:
        super().__init__()  # pyright: ignore [reportUnknownMemberType]

        assert layer_norm_first is False, "`layer_norm_first` is fixed to `False`"
        assert activation_fn == "gelu", "`activation_fn` is fixed to `gelu`"

        feat = embedding_dim

        self.self_attn = MultiheadAttention(
            feat, num_attention_heads, attention_dropout
        )
        self.dropout1 = nn.Dropout(dropout)
        self.dropout2 = nn.Dropout(activation_dropout)
        self.dropout3 = nn.Dropout(dropout)
        self.fc1 = nn.Linear(feat, ffn_embedding_dim)
        self.fc2 = nn.Linear(ffn_embedding_dim, feat)
        self.self_attn_layer_norm = nn.LayerNorm(feat)
        self.final_layer_norm = nn.LayerNorm(feat)

    def forward(self, x: Tensor, self_attn_padding_mask: Optional[Tensor]):
        # Res[Attn-Do]-LN
        residual = x
        x = self.self_attn(x, x, x, self_attn_padding_mask)
        x = self.dropout1(x)
        x = residual + x
        x = self.self_attn_layer_norm(x)

        # Res[SegFC-GELU-Do-SegFC-Do]-LN
        residual = x
        x = F.gelu(self.fc1(x))  # pyright: ignore [reportUnknownMemberType]
        x = self.dropout2(x)
        x = self.fc2(x)
        x = self.dropout3(x)
        x = residual + x
        x = self.final_layer_norm(x)

        return x


class MultiheadAttention(nn.Module):
    """Multi-headed attention."""

    def __init__(self, embed_dim: int, num_heads: int, dropout: float):
        super().__init__()  # pyright: ignore [reportUnknownMemberType]

        self.embed_dim, self.num_heads, self.p_dropout = embed_dim, num_heads, dropout
        self.q_proj = nn.Linear(embed_dim, embed_dim, bias=True)
        self.k_proj = nn.Linear(embed_dim, embed_dim, bias=True)
        self.v_proj = nn.Linear(embed_dim, embed_dim, bias=True)
        self.out_proj = nn.Linear(embed_dim, embed_dim, bias=True)

    def forward(
        self,
        query: Tensor,
        key: Tensor,
        value: Tensor,
        key_padding_mask: Optional[Tensor],
    ) -> Tensor:
        """
        Args:
            query            :: (T, B, Feat)
            key_padding_mask :: (B, src_len) - mask to exclude keys that are pads
                , where padding elements are indicated by 1s.
        """
        return F.multi_head_attention_forward(
            query=query,
            key=key,
            value=value,
            embed_dim_to_check=self.embed_dim,
            num_heads=self.num_heads,
            in_proj_weight=torch.empty([0]),
            in_proj_bias=torch.cat(
                (self.q_proj.bias, self.k_proj.bias, self.v_proj.bias)
            ),
            bias_k=None,
            bias_v=None,
            add_zero_attn=False,
            dropout_p=self.p_dropout,
            out_proj_weight=self.out_proj.weight,
            out_proj_bias=self.out_proj.bias,
            training=False,
            key_padding_mask=key_padding_mask.bool()
            if key_padding_mask is not None
            else None,
            need_weights=False,
            use_separate_proj_weight=True,
            q_proj_weight=self.q_proj.weight,
            k_proj_weight=self.k_proj.weight,
            v_proj_weight=self.v_proj.weight,
        )[0]
