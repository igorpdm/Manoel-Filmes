export interface ChangelogChange {
  category: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  title: string;
  date: string;
  changes: ChangelogChange[];
}

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    version: "v1.7.0",
    title: "Cancelamento e Retomada de Upload",
    date: "15/04/2026",
    changes: [
      {
        category: "🆕 Novidades",
        items: [
          "Botão \"Cancelar Upload\" disponível durante o envio — agora é possível interromper um upload em andamento",
          "Retomada de upload — arquivos parcialmente enviados podem ser continuados ao atualizar a página",
        ],
      },
      {
        category: "🐛 Correções",
        items: [
          "Overlay de upload não fica mais congelado quando o host recarrega a página durante um envio",
          "Uploads residuais de sessões anteriores são removidos automaticamente ao iniciar o servidor",
          "Corrigido problema que impedia o reupload de um mesmo arquivo após cancelamento",
        ],
      },
    ],
  },
  {
    version: "v1.6.0",
    title: "Performance e WebGPU",
    date: "14/04/2026",
    changes: [
      {
        category: "🆕 Novidades",
        items: [
          "Comando /changelog adicionado — veja o histórico completo de atualizações do bot diretamente no Discord, com navegação por versões via botões",
        ],
      },
      {
        category: "⚡ Performance",
        items: [
          "Renderização via WebGPU implementada como primeira opção no upscaler, com fallback automático para WebGL2 quando não suportado",
          "Pipeline WebGL2 otimizado com contexto high-performance, shaders revisados e remoção de chamadas de estado redundantes",
          "Conversão de áudio AAC até 2× mais rápida com o modo fast do encoder FFmpeg",
        ],
      },
      {
        category: "🐛 Correções",
        items: [
          "Canvas removido do DOM ao desativar o upscaler, restaurando o Hardware Overlay do navegador e corrigindo desync de áudio/vídeo em tela cheia",
          "Separador de caminhos corrigido no upload para Windows (path.sep em vez de '/' fixo)",
          "Estilos visuais restaurados após regressão introduzida na atualização do upscaler",
        ],
      },
    ],
  },
  {
    version: "v1.5.0",
    title: "Login OAuth com Discord",
    date: "09/04/2026",
    changes: [
      {
        category: "🆕 Novidades",
        items: [
          "Autenticação OAuth com Discord — o botão \"Entrar na Sessão\" agora é um link direto, sem interação adicional do bot",
          "Sessão mantida via cookies assinados com HMAC-SHA256 e proteção CSRF por parâmetro state",
          "Avatar do Discord exibido na lista de espectadores durante a sessão",
          "Host pode cancelar a sessão a qualquer momento antes do início",
        ],
      },
      {
        category: "✨ Melhorias",
        items: [
          "Encerramento de sessão com timeout de votação — evita que a sessão fique presa aguardando votos",
          "Tela de login completamente redesenhada",
          "Sistema de recomendações aprimorado com mais contexto e segurança adicional no player",
        ],
      },
      {
        category: "🐛 Correções",
        items: [
          "Busca de trailers corrigida para retornar resultados mais precisos",
        ],
      },
    ],
  },
  {
    version: "v1.4.0",
    title: "Upscaling de Vídeo e Maratonas",
    date: "08/04/2026",
    changes: [
      {
        category: "🆕 Novidades",
        items: [
          "Upscaling de vídeo com FSR1 (AMD FidelityFX Super Resolution) e CAS (Contrast Adaptive Sharpening) disponíveis no player",
          "Avaliações persistidas por episódio em sessões de maratona — cada episódio tem sua própria nota independente",
        ],
      },
      {
        category: "✨ Melhorias",
        items: [
          "Banco de dados dividido em módulos especializados (filmes, avaliações, watchlist, votações)",
          "Rota de upload reestruturada em arquivos menores por responsabilidade",
        ],
      },
      {
        category: "🐛 Correções",
        items: [
          "Cores incorretas ao utilizar o upscaler corrigidas",
        ],
      },
    ],
  },
  {
    version: "v1.3.0",
    title: "Suporte a Séries",
    date: "28/03/2026",
    changes: [
      {
        category: "🆕 Novidades",
        items: [
          "Fluxo contínuo de múltiplos episódios — ao terminar um episódio, o próximo é carregado automaticamente durante a sessão",
        ],
      },
      {
        category: "✨ Melhorias",
        items: [
          "Badge do player agora exibe latência (ping) em vez de velocidade de download, métrica mais relevante para streaming",
        ],
      },
      {
        category: "🐛 Correções",
        items: [
          "Overlay de processamento não fica mais preso após upload com áudio já compatível",
        ],
      },
    ],
  },
  {
    version: "v1.2.0",
    title: "Autenticação de Sessão",
    date: "14/03/2026",
    changes: [
      {
        category: "🆕 Novidades",
        items: [
          "Autenticação centralizada por token de serviço para todas as sessões",
          "Token obrigatório no player e nos endpoints de streaming — acesso não autenticado bloqueado",
        ],
      },
      {
        category: "✨ Melhorias",
        items: [
          "Normalização de roomId e token nas conexões WebSocket",
          "Fluxo de autorização legado removido, simplificando a arquitetura",
        ],
      },
      {
        category: "🐛 Correções",
        items: [
          "Seleção de temporadas limitada a 25 itens conforme o limite da API do Discord",
        ],
      },
    ],
  },
  {
    version: "v1.1.0",
    title: "Melhorias de Upload e Legendas",
    date: "09/03/2026",
    changes: [
      {
        category: "🆕 Novidades",
        items: [
          "Seleção de faixa de áudio durante o upload — escolha qual trilha incluir antes do processamento",
          "Suporte a tags de formatação inline nas legendas (negrito, itálico, cor em arquivos .srt)",
          "Extração de legendas em background, tornando o upload mais rápido",
        ],
      },
      {
        category: "✨ Melhorias",
        items: [
          "Recuperação automática do fluxo de áudio após falha de conversão",
          "Reaproveitamento de metadados no pipeline de processamento, evitando operações redundantes",
        ],
      },
      {
        category: "🐛 Correções",
        items: [
          "Legendas agora são extraídas corretamente em uma única execução",
        ],
      },
    ],
  },
  {
    version: "v1.0.0",
    title: "Lançamento",
    date: "08/02/2026",
    changes: [
      {
        category: "🎬 Bot",
        items: [
          "Busca de filmes via TMDB com trailer automático do YouTube (/pesquisar)",
          "Lista de filmes assistidos com avaliações do grupo (/listar)",
          "Sistema de votação com notas de 1 a 10 por filme (/registrar)",
          "Watchlist — filmes que o grupo quer assistir (/watchlist)",
          "Recomendações geradas por IA com base no histórico do grupo (/recomendar)",
        ],
      },
      {
        category: "🎥 Sessões",
        items: [
          "Sessão de assistir sincronizado com upload e streaming integrados (/sessao)",
          "Painel web com visualizações e estatísticas do grupo",
        ],
      },
    ],
  },
];
