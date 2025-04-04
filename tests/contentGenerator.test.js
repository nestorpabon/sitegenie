const axios = require('axios');
const { generateContent, createContent, processContent, checkPlagiarism } = require('../src/contentGenerator');

// Mock dependencies
jest.mock('axios');
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));
jest.mock('../src/utils/queue', () => ({
  addToQueue: jest.fn().mockResolvedValue(true)
}));

// Mock environment variables
process.env.OPENAI_API_KEY = 'mock-api-key';
process.env.COPYSCAPE_USERNAME = 'mock-username';
process.env.COPYSCAPE_API_KEY = 'mock-api-key';

describe('Content Generator Module', () => {
  // Reset mocks before each test
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateContent', () => {
    const mockContentBrief = {
      niche: 'indoor hydroponics',
      topic: 'Best Hydroponic Systems for Beginners',
      primaryKeyword: 'beginner hydroponic systems',
      wordCount: 1500,
      sections: ['Introduction', 'What is Hydroponics', 'Top Systems', 'Conclusion'],
      targetAudience: 'Beginner gardeners',
      secondaryKeywords: ['indoor growing', 'hydroponic starter kit'],
      tone: 'informative'
    };

    const mockOpenAIResponse = {
      data: {
        choices: [
          {
            message: {
              content: 'This is a generated article about hydroponics.'
            }
          }
        ],
        usage: {
          total_tokens: 1200
        }
      }
    };

    test('should successfully generate content', async () => {
      // Setup
      axios.post.mockResolvedValueOnce(mockOpenAIResponse);
      
      // Execute
      const result = await generateContent(mockContentBrief);
      
      // Assert
      expect(result.status).toBe('success');
      expect(result.content).toBe('This is a generated article about hydroponics.');
      expect(result.tokens_used).toBe(1200);
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          model: 'gpt-4',
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'system' }),
            expect.objectContaining({ role: 'user' })
          ])
        }),
        expect.any(Object)
      );
    });

    test('should handle API rate limiting', async () => {
      // Setup
      const rateLimitError = {
        response: {
          status: 429,
          data: { error: { message: 'Rate limit exceeded' } }
        }
      };
      axios.post.mockRejectedValueOnce(rateLimitError);
      
      // Execute
      const result = await generateContent(mockContentBrief);
      
      // Assert
      expect(result.status).toBe('queued');
      expect(result.message).toContain('Rate limit reached');
    });

    test('should fall back to GPT-3.5 on OpenAI service error', async () => {
      // Setup
      const serviceError = {
        response: {
          status: 503,
          data: { error: { message: 'Service unavailable' } }
        }
      };
      
      // First call fails with service error
      axios.post.mockRejectedValueOnce(serviceError);
      
      // Second call to fallback model succeeds
      axios.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: 'Fallback content from GPT-3.5' } }],
          usage: { total_tokens: 800 }
        }
      });
      
      // Execute
      const result = await generateContent(mockContentBrief);
      
      // Assert
      expect(result.status).toBe('success');
      expect(result.content).toBe('Fallback content from GPT-3.5');
      expect(result.model_used).toBe('gpt-3.5-turbo');
      expect(result.is_fallback).toBe(true);
    });
  });

  describe('processContent', () => {
    const mockContentBrief = {
      primaryKeyword: 'hydroponic gardening',
      wordCount: 1500
    };

    test('should correctly calculate content metrics', () => {
      // Setup
      const content = 'Hydroponic gardening is a modern method of growing plants. ' +
                     'Hydroponic gardening uses water instead of soil. This hydroponic gardening guide explains everything.';
      
      // Execute
      const result = processContent(content, mockContentBrief);
      
      // Assert
      expect(result.metrics.wordCount).toBe(24);
      expect(result.metrics.keywordDensity).toBeCloseTo(12.5, 1); // 3 occurrences out of 24 words
      expect(result.metrics.includesPrimaryKeyword).toBe(true);
    });

    test('should add warnings for low word count', () => {
      // Setup
      const content = 'Short hydroponic article.';
      
      // Execute
      const result = processContent(content, mockContentBrief);
      
      // Assert
      expect(result.warnings).toContain('Content length below target');
    });

    test('should add warnings for poor keyword density', () => {
      // Setup - too high density
      const highDensityContent = 'Hydroponic gardening. Hydroponic gardening. Hydroponic gardening.';
      
      // Execute
      const result = processContent(highDensityContent, mockContentBrief);
      
      // Assert
      expect(result.warnings).toContain('Keyword density outside optimal range (0.5% - 3%)');
    });
  });

  describe('checkPlagiarism', () => {
    test('should detect plagiarized content', async () => {
      // Setup - mock Copyscape response with matches
      axios.post.mockResolvedValueOnce({
        data: {
          result: [
            {
              url: 'https://example.com/article',
              title: 'Original Article',
              wordsmatched: '50',
              textsnippet: 'This is the matched text snippet'
            }
          ]
        }
      });
      
      const content = 'This is a test article with some content that might be plagiarized. ' +
                     'It contains about 100 words total, and we are simulating that 50 of them match another source.';
      
      // Execute
      const result = await checkPlagiarism(content);
      
      // Assert
      expect(result.isPlagiarized).toBe(true);
      expect(result.similarityScore).toBeGreaterThanOrEqual(5); // Should be 50%
      expect(result.sources.length).toBe(1);
      expect(result.sources[0].url).toBe('https://example.com/article');
    });

    test('should identify original content', async () => {
      // Setup - mock Copyscape response with no matches
      axios.post.mockResolvedValueOnce({
        data: {
          result: [] // No matches found
        }
      });
      
      const content = 'This is completely original content with no matches.';
      
      // Execute
      const result = await checkPlagiarism(content);
      
      // Assert
      expect(result.isPlagiarized).toBe(false);
      expect(result.similarityScore).toBe(0);
      expect(result.totalMatches).toBe(0);
    });

    test('should handle Copyscape API errors gracefully', async () => {
      // Setup - mock Copyscape API error
      axios.post.mockRejectedValueOnce(new Error('API connection failed'));
      
      const content = 'Test content for error handling.';
      
      // Execute
      const result = await checkPlagiarism(content);
      
      // Assert
      expect(result.status).toBe('error');
      expect(result.isPlagiarized).toBe(false); // Default to false when check fails
      expect(result.message).toContain('Plagiarism check failed');
    });

    test('should skip plagiarism check when API credentials are missing', async () => {
      // Setup - temporarily remove API credentials
      const originalUsername = process.env.COPYSCAPE_USERNAME;
      const originalApiKey = process.env.COPYSCAPE_API_KEY;
      delete process.env.COPYSCAPE_USERNAME;
      delete process.env.COPYSCAPE_API_KEY;
      
      const content = 'Test content with missing API credentials.';
      
      // Execute
      const result = await checkPlagiarism(content);
      
      // Assert
      expect(result.status).toBe('skipped');
      expect(result.isPlagiarized).toBe(false);
      
      // Restore credentials
      process.env.COPYSCAPE_USERNAME = originalUsername;
      process.env.COPYSCAPE_API_KEY = originalApiKey;
    });
  });

  describe('createContent', () => {
    const mockContentBrief = {
      niche: 'indoor hydroponics',
      topic: 'Beginner Guide',
      primaryKeyword: 'hydroponic gardening',
      wordCount: 1000,
      sections: ['Intro', 'Guide', 'Conclusion'],
      targetAudience: 'Beginners'
    };

    test('should generate, process, and check content for plagiarism', async () => {
      // Setup - mock successful content generation
      axios.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: 'Generated content about hydroponic gardening.' } }],
          usage: { total_tokens: 500 }
        }
      });

      // Mock successful plagiarism check
      axios.post.mockResolvedValueOnce({
        data: {
          result: [] // No plagiarism found
        }
      });
      
      // Execute
      const result = await createContent(mockContentBrief);
      
      // Assert
      expect(result.status).toBe('success');
      expect(result.content).toBe('Generated content about hydroponic gardening.');
      expect(result.plagiarismCheck).toBeDefined();
      expect(result.plagiarismCheck.isPlagiarized).toBe(false);
    });

    test('should skip plagiarism check when specified', async () => {
      // Setup - mock successful content generation
      axios.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: 'Generated content without plagiarism check.' } }],
          usage: { total_tokens: 500 }
        }
      });
      
      // Execute with skipPlagiarismCheck = true
      const result = await createContent(mockContentBrief, true);
      
      // Assert
      expect(result.status).toBe('success');
      expect(result.content).toBe('Generated content without plagiarism check.');
      expect(result.plagiarismCheck).toBeUndefined(); // Plagiarism check should be skipped
    });

    test('should handle detected plagiarism appropriately', async () => {
      // Setup - mock successful content generation
      axios.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: 'This content is plagiarized from somewhere.' } }],
          usage: { total_tokens: 500 }
        }
      });

      // Mock plagiarism check with positive result
      axios.post.mockResolvedValueOnce({
        data: {
          result: [
            {
              url: 'https://example.com/original',
              title: 'Original Source',
              wordsmatched: '6',  // 6 out of 7 words match
              textsnippet: 'This content is plagiarized from somewhere'
            }
          ]
        }
      });
      
      // Execute
      const result = await createContent(mockContentBrief);
      
      // Assert
      expect(result.status).toBe('failed');
      expect(result.message).toContain('plagiarism');
      expect(result.plagiarismDetails).toBeDefined();
      expect(result.plagiarismDetails.isPlagiarized).toBe(true);
      expect(result.originalContent).toBeDefined(); // Should include the rejected content
    });

    test('should return early if content generation fails', async () => {
      // Setup - mock failed content generation
      axios.post.mockRejectedValueOnce(new Error('Generation failed'));
      
      // Mock fallback generation also fails
      axios.post.mockRejectedValueOnce(new Error('Fallback also failed'));
      
      // Execute
      const result = await createContent(mockContentBrief);
      
      // Assert
      expect(result.status).toBe('failed');
      expect(result.message).toContain('unsuccessful');
      // Plagiarism check should not be attempted
      expect(axios.post).toHaveBeenCalledTimes(2); // Only the 2 generation attempts, no plagiarism check
    });
  });
});
