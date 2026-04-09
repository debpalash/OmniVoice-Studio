import gradio as gr
from gradio_client import Client, handle_file
import tempfile
import os

from omnivoice.utils.lang_map import LANG_NAMES, lang_display_name

_ALL_LANGUAGES = ["Auto"] + sorted(lang_display_name(n) for n in LANG_NAMES)

_CATEGORIES = {
    "Gender / 性别": ["Male / 男", "Female / 女"],
    "Age / 年龄": [
        "Child / 儿童",
        "Teenager / 少年",
        "Young Adult / 青年",
        "Middle-aged / 中年",
        "Elderly / 老年",
    ],
    "Pitch / 音调": [
        "Very Low Pitch / 极低音调",
        "Low Pitch / 低音调",
        "Moderate Pitch / 中音调",
        "High Pitch / 高音调",
        "Very High Pitch / 极高音调",
    ],
    "Style / 风格": ["Whisper / 耳语"],
    "English Accent / 英文口音": [
        "American Accent / 美式口音",
        "Australian Accent / 澳大利亚口音",
        "British Accent / 英国口音",
        "Chinese Accent / 中国口音",
        "Canadian Accent / 加拿大口音",
        "Indian Accent / 印度口音",
        "Korean Accent / 韩国口音",
        "Portuguese Accent / 葡萄牙口音",
        "Russian Accent / 俄罗斯口音",
        "Japanese Accent / 日本口音",
    ],
    "Chinese Dialect / 中文方言": [
        "Henan Dialect / 河南话",
        "Shaanxi Dialect / 陕西话",
        "Sichuan Dialect / 四川话",
        "Guizhou Dialect / 贵州话",
        "Yunnan Dialect / 云南话",
        "Guilin Dialect / 桂林话",
        "Jinan Dialect / 济南话",
        "Shijiazhuang Dialect / 石家庄话",
        "Gansu Dialect / 甘肃话",
        "Ningxia Dialect / 宁夏话",
        "Qingdao Dialect / 青岛话",
        "Northeast Dialect / 东北话",
    ],
}

_ATTR_INFO = {
    "English Accent / 英文口音": "Only effective for English speech.",
    "Chinese Dialect / 中文方言": "Only effective for Chinese speech.",
}

client = Client("k2-fsa/OmniVoice")

def _lang_dropdown(label="Language (optional) / 语种 (可选)", value="Auto"):
    return gr.Dropdown(
        label=label,
        choices=_ALL_LANGUAGES,
        value=value,
        allow_custom_value=False,
        interactive=True,
    )

def _gen_settings():
    with gr.Accordion("Generation Settings (optional)", open=False):
        sp = gr.Slider(0.5, 1.5, value=1.0, step=0.05, label="Speed")
        du = gr.Number(value=0, label="Duration (seconds)") # Used 0 instead of None to match number input requirements, handle inside logic if needed
        ns = gr.Slider(4, 64, value=32, step=1, label="Inference Steps")
        dn = gr.Checkbox(label="Denoise", value=True)
        gs = gr.Slider(0.0, 4.0, value=2.0, step=0.1, label="Guidance Scale (CFG)")
        pp = gr.Checkbox(label="Preprocess Prompt", value=True)
        po = gr.Checkbox(label="Postprocess Output", value=True)
    return ns, gs, dn, sp, du, pp, po

theme = gr.themes.Soft(font=["Inter", "Arial", "sans-serif"])
css = """
.gradio-container {max-width: 100% !important; font-size: 16px !important;}
.gradio-container h1 {font-size: 1.5em !important;}
.gradio-container .prose {font-size: 1.1em !important;}
.compact-audio audio {height: 60px !important;}
.compact-audio .waveform {min-height: 80px !important;}
"""

with gr.Blocks(theme=theme, css=css, title="OmniVoice Client UI") as demo:
    gr.Markdown(
        """
        # OmniVoice Client UI
        
        This UI connects remotely to the `k2-fsa/OmniVoice` space via API. It supports Voice Clone and Voice Design.
        """
    )

    with gr.Tabs():
        # ================= Voice Clone Tab =================
        with gr.TabItem("Voice Clone"):
            with gr.Row():
                with gr.Column(scale=1):
                    vc_text = gr.Textbox(label="Text to Synthesize / 待合成文本", lines=4)
                    vc_ref_audio = gr.Audio(label="Reference Audio / 参考音频", type="filepath", elem_classes="compact-audio")
                    vc_ref_text = gr.Textbox(label="Reference Text (optional) / 参考音频文本（可选）", lines=2)
                    vc_lang = _lang_dropdown()
                    
                    with gr.Accordion("Instruct (optional)", open=False):
                        vc_instruct = gr.Textbox(label="Instruct", lines=2)
                        
                    vc_ns, vc_gs, vc_dn, vc_sp, vc_du, vc_pp, vc_po = _gen_settings()
                    vc_btn = gr.Button("Generate / 生成", variant="primary")
                    
                with gr.Column(scale=1):
                    vc_audio = gr.Audio(label="Output Audio / 合成结果", type="filepath")
                    vc_status = gr.Textbox(label="Status / 状态", lines=2)

            def clone_wrapper(text, lang, ref_aud, ref_text, instruct, ns, gs, dn, sp, du, pp, po):
                if not ref_aud:
                    return None, "Error: Must provide reference audio for Voice Clone."
                try:
                    result = client.predict(
                        text=text or "",
                        lang=lang or "Auto",
                        ref_aud=handle_file(ref_aud),
                        ref_text=ref_text or "",
                        instruct=instruct or "",
                        ns=ns,
                        gs=gs,
                        dn=dn,
                        sp=sp,
                        du=du or 0,
                        pp=pp,
                        po=po,
                        api_name="/_clone_fn"
                    )
                    return result[0], result[1]
                except Exception as e:
                    return None, f"Error: {e}"

            vc_btn.click(
                clone_wrapper,
                inputs=[vc_text, vc_lang, vc_ref_audio, vc_ref_text, vc_instruct, vc_ns, vc_gs, vc_dn, vc_sp, vc_du, vc_pp, vc_po],
                outputs=[vc_audio, vc_status]
            )

        # ================= Voice Design Tab =================
        with gr.TabItem("Voice Design"):
            with gr.Row():
                with gr.Column(scale=1):
                    vd_text = gr.Textbox(label="Text to Synthesize / 待合成文本", lines=4)
                    vd_lang = _lang_dropdown()

                    vd_groups = []
                    for _cat, _choices in _CATEGORIES.items():
                        vd_groups.append(
                            gr.Dropdown(
                                label=_cat,
                                choices=["Auto"] + _choices,
                                value="Auto",
                                info=_ATTR_INFO.get(_cat),
                            )
                        )

                    vd_ns, vd_gs, vd_dn, vd_sp, vd_du, vd_pp, vd_po = _gen_settings()
                    vd_btn = gr.Button("Generate / 生成", variant="primary")
                    
                with gr.Column(scale=1):
                    vd_audio = gr.Audio(label="Output Audio / 合成结果", type="filepath")
                    vd_status = gr.Textbox(label="Status / 状态", lines=2)

            def design_wrapper(text, lang, ns, gs, dn, sp, du, pp, po, *groups):
                try:
                    # groups mapped to param_9 ... param_14
                    result = client.predict(
                        text=text or "",
                        lang=lang or "Auto",
                        ns=ns,
                        gs=gs,
                        dn=dn,
                        sp=sp,
                        du=du or 0,
                        pp=pp,
                        po=po,
                        param_9=groups[0],
                        param_10=groups[1],
                        param_11=groups[2],
                        param_12=groups[3],
                        param_13=groups[4],
                        param_14=groups[5],
                        api_name="/_design_fn"
                    )
                    return result[0], result[1]
                except Exception as e:
                    return None, f"Error: {e}"

            vd_btn.click(
                design_wrapper,
                inputs=[vd_text, vd_lang, vd_ns, vd_gs, vd_dn, vd_sp, vd_du, vd_pp, vd_po] + vd_groups,
                outputs=[vd_audio, vd_status]
            )

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
