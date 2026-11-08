import Image from "next/image";

export function ChatSiteExamplePreview() {
  return (
    <div className="real-shot-preview">
      <Image
        src="/mcpgo-real-example.png"
        unoptimized
        width={1916}
        height={1189}
        priority
        alt="Пример работы McpGo: ChatGPT с отчётом о создании сайта и открытая страница результата."
        className="real-shot-preview-image"
        sizes="(max-width: 520px) 350px, (max-width: 1050px) 85vw, 660px"
      />
    </div>
  );
}
